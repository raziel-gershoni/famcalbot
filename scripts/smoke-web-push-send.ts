// Smoke test for the browser notification sender (spec docs/superpowers/specs/2026-11-05-web-push-design.md §3.3, §3.4,
// §3.6; plan 6c-2 Task 2): src/services/web-push/payload.ts and send.ts.
//
// What it pins:
//   - the payload: Apple's declarative JSON for every browser (web_push 8030, title, body, navigate, lang, dir, tag,
//     silent), at most 2048 bytes of UTF-8, a long title then the body cut with "…" (never half a character, or inside a niqqud, ZWJ or flag cluster); the Topic,
//     32 base64url characters of a SHA-256 of the tag, carrying no tag text;
//   - the lifetime (TTL): the kind's own, an alert's event start, and for a scheduled kind the next Shabbat or Yom Tov
//     window (asked of nextPauseStart, and only for those kinds), never above a day, never below a second;
//   - the request: web-push builds and encrypts it (the body decrypts, with the subscriber's keys, to the payload),
//     fetchWithRetry sends it, with TTL, Urgency, Topic and aes128gcm; the VAPID header is signed by our key with
//     FamCal's contact, one per push service, kept for an hour and made anew after it;
//   - the answers: any 2xx is sent; 404 and 410 delete the device; 429, 5xx and no answer are retried by the loop and
//     a give-up is retriable; a Retry-After over 10 s fails at once; 400 and 413 are reported; 401 and 403 are reported
//     once a day per device;
//   - push off (no keys) and no devices send nothing; a device whose stored key the library refuses is skipped and
//     reported while the others go; a failed device read is retriable; it never throws; one log line per send;
//   - onlyEndpoint (ruling R1): a send for one endpoint reaches that device alone, an unknown endpoint nobody;
//   - the push POST never follows a redirect (a 3xx is refused and reported, not sent on to another host);
//   - no console line or Sentry field holds an endpoint, a key, the title or the body;
//   - the code: no sendNotification, no setVapidDetails, no Google retry policy; web-push and its types pinned exact;
//     CLAUDE.md's two retry rules and fetch-retry.ts's header send every push service, FCM included, through fetchWithRetry.
//
// Real: payload.ts, send.ts, config.ts, fetch-retry.ts (waits skipped), web-push. Faked: the devices (devices.ts), the
// pause's next window (pause.ts; scripts/smoke-pause.ts tests the real one), the push services (fetch), error capture
// (scripts/lib/signin-world.ts). No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   $RUN smoke-web-push-send

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import {
  assert, captured, check, everyCapture, everyLog, installSigninWorld, load, logs, report, resetWorld, ROOT, show, stubModule, type Row,
} from './lib/signin-world';

const nodeRequire = createRequire(__filename);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const webpush = nodeRequire('web-push') as { generateVAPIDKeys: () => { publicKey: string; privateKey: string } };
const ece = createRequire(nodeRequire.resolve('web-push'))('http_ece') as { decrypt: (body: Buffer, params: Row) => Buffer };

const VAPID = webpush.generateVAPIDKeys();
const setKeys = () => {
  process.env.VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.VAPID_PRIVATE_KEY = VAPID.privateKey;
};
setKeys();

interface Subscriber { ecdh: crypto.ECDH; authSecret: Buffer; p256dh: string; auth: string }
function subscriber(): Subscriber {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return { ecdh, authSecret, p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') };
}
const S1 = subscriber();
const S2 = subscriber();
const FCM = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ';
const APPLE = 'https://web.push.apple.com/QGuQyavXutnMH7Yfc6PB9mxXzqrBm2rWvzGJ7oM8hGfTxwvW-5rNjzQZq0G9IBbx';
const D1 = { id: 'dev-fcm', endpoint: FCM, p256dh: S1.p256dh, auth: S1.auth };
const D2 = { id: 'dev-apple', endpoint: APPLE, p256dh: S2.p256dh, auth: S2.auth };
const SUBSCRIBER_OF: Record<string, Subscriber> = { [FCM]: S1, [APPLE]: S2 };

const USER = { id: 7, pauseOnShabbat: true, zmanimCommunity: 'sephardi' };
const TITLE = 'לאסוף את נועה מהגן';
const BODY = 'תזכורת לשעה ארבע';
const MESSAGE = { kind: 'reminder' as const, title: TITLE, body: BODY, url: 'https://famcal.bot/he/dashboard', tag: 'nr-clx7stateid', lang: 'he' as const };
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---- The world: the devices, the next pause window, the push services ----

let devices: Row[] = [];
let deviceReads = 0;
let readFails = false;
const gone: string[] = [];
const pauseAsks: { userId: number; from: string; withinMs: number }[] = [];
let pauseAnswer: Date | null = null;
type Answer = number | Error | { status: number; retryAfter: string };
const answers = new Map<string, Answer[]>();
const pushes: { url: string; method: string; redirect: string | undefined; headers: Headers; body: Buffer }[] = [];
const pushesTo = (url: string) => pushes.filter((p) => p.url === url);
/** A length read through a call: the world is changed by reset() and the sends, which TypeScript's narrowing of `x.length` cannot see. */
const count = (list: unknown[]) => list.length;
const sendLines = () => logs.filter((l) => /^\[push\] user \d+: \S+ sent to \d+ of \d+ devices$/.test(l));

function decrypt(push: { url: string; body: Buffer }): string {
  const s = SUBSCRIBER_OF[push.url];
  return ece.decrypt(push.body, { version: 'aes128gcm', privateKey: s.ecdh, authSecret: s.authSecret }).toString('utf8');
}

/** A VAPID Authorization header: its signature checked against its own key, and its claims. */
function vapidOf(authorization: string | null): { ok: boolean; key: string; claims: Row } {
  const m = /^vapid t=([^,]+), k=(\S+)$/.exec(authorization ?? '');
  assert(m, `not a VAPID Authorization: ${String(authorization).slice(0, 20)}`);
  const [header, payload, signature] = m[1].split('.');
  const pub = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  return { ok, key: m[2], claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) };
}

async function main() {
  await installSigninWorld();
  stubModule('src/services/web-push/devices.ts', {
    MAX_DEVICES: 10,
    devicesForSend: async (userId: number) => {
      deviceReads++;
      // A Prisma error's message can print the query's values: the sender must not log it
      if (readFails) throw Object.assign(new Error(`Invalid \`prisma.pushDevice.findMany()\` invocation near ${FCM}`), { name: 'PrismaClientUnknownRequestError' });
      return userId === USER.id ? devices.map((d) => ({ ...d })) : [];
    },
    deleteGoneDevice: async (id: string) => { gone.push(id); },
  });
  stubModule('src/services/zmanim/pause.ts', {
    isPaused: async () => false,
    nextPauseStart: async (user: Row, from: Date, withinMs: number) => {
      pauseAsks.push({ userId: user.id, from: from.toISOString(), withinMs });
      return pauseAnswer;
    },
  });
  // The push services: each endpoint answers from its queue (default 201), and every request is kept
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    pushes.push({ url, method: String(init.method), redirect: init.redirect, headers: new Headers(init.headers), body: Buffer.from((init.body ?? new Uint8Array()) as Uint8Array) });
    const next = answers.get(url)?.shift() ?? 201;
    if (next instanceof Error) throw next;
    const { status, retryAfter } = typeof next === 'number' ? { status: next, retryAfter: undefined } : next;
    return new Response(null, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
  }) as typeof fetch;
  const retry = await load('src/utils/fetch-retry.ts');
  retry.__useRetryForTests({ sleep: async () => undefined, random: () => 0 });
  const payload = await load('src/services/web-push/payload.ts').catch(() => ({} as Row));
  const send = await load('src/services/web-push/send.ts').catch(() => ({ __resetPushForTests: () => undefined } as Row));

  const reset = () => {
    resetWorld();
    send.__resetPushForTests();
    setKeys();
    devices = [D1, D2];
    deviceReads = 0;
    readFails = false;
    gone.length = 0;
    pauseAsks.length = 0;
    pauseAnswer = null;
    answers.clear();
    pushes.length = 0;
  };
  const T0 = new Date();

  await check('W1 the payload: one declarative JSON (web_push 8030; title, body, navigate, lang, dir rtl for Hebrew and ltr otherwise, tag, silent); at most 2048 bytes of UTF-8, a long title cut first but never below half the room, then the body, each with "…" and never half a character; the Topic is 32 base64url characters of the tag\'s SHA-256, the same for the same tag and none of its text', () => {
    const parsed = JSON.parse(payload.buildPushPayload(MESSAGE));
    assert(show(parsed) === show({ web_push: 8030, notification: { title: TITLE, body: BODY, navigate: MESSAGE.url, lang: 'he', dir: 'rtl', tag: MESSAGE.tag, silent: false } }), `payload ${show(parsed)}`);
    const en = JSON.parse(payload.buildPushPayload({ ...MESSAGE, lang: 'en', silent: true })).notification;
    const ru = JSON.parse(payload.buildPushPayload({ ...MESSAGE, lang: 'ru' })).notification;
    assert(en.dir === 'ltr' && en.silent === true && ru.dir === 'ltr' && ru.lang === 'ru', `en ${show(en)} ru ${show(ru)}`);
    const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const room = payload.MAX_PAYLOAD_BYTES - bytes(payload.buildPushPayload({ ...MESSAGE, title: '', body: '' }));
    assert(payload.MAX_PAYLOAD_BYTES === 2048, `MAX_PAYLOAD_BYTES ${payload.MAX_PAYLOAD_BYTES}`);
    const cases: [string, string, string][] = [
      ['both long (Hebrew, 2 bytes a letter)', 'ת'.repeat(1500), 'ב'.repeat(1500)],
      ['a long title, a short body', 'ת'.repeat(1500), BODY],
      ['a short title, a long body', 'היום', 'ב'.repeat(1500)],
      ['emoji (4 bytes, two UTF-16 halves)', '😀'.repeat(800), '😀'.repeat(800)],
      ['quotes and backslashes (escaped in JSON)', '"\\'.repeat(900), 'x'],
    ];
    for (const [label, title, body] of cases) {
      const out = payload.buildPushPayload({ ...MESSAGE, title, body });
      const n = JSON.parse(out).notification;
      assert(bytes(out) <= 2048, `${label}: ${bytes(out)} bytes`);
      assert(!lone.test(n.title) && !lone.test(n.body), `${label}: half a character`);
      if (title.length > 100) assert(n.title.endsWith('…'), `${label}: the title is not cut with "…"`);
      if (body === BODY || body === 'x') assert(n.body === body, `${label}: a short body was cut: ${n.body}`);
      if (title === 'היום') assert(n.title === 'היום' && n.body.endsWith('…'), `${label}: ${show(n)}`);
      if (body.length > 100 && title.length > 100) assert(bytes(JSON.stringify(n.title)) - 2 >= Math.floor(room / 2) - 8, `${label}: the title fell below half the room (${bytes(n.title)} of ${room})`);
    }
    // A cut lands only between whole user-perceived characters: a Hebrew letter keeps its niqqud, an emoji its ZWJ joins, a flag both halves
    const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
    const clusters: [string, string][] = [['pointed Hebrew', 'שָׁ'], ['a ZWJ family emoji', '👨\u200D👩\u200D👧'], ['a flag', '🇮🇱']];
    for (const [label, unit] of clusters) {
      for (let pad = 0; pad < 6; pad++) {
        const title = 'x'.repeat(pad) + unit.repeat(900);
        const cutTitle = JSON.parse(payload.buildPushPayload({ ...MESSAGE, title, body: 'x' })).notification.title as string;
        assert(cutTitle.endsWith('…'), `${label} pad ${pad}: not cut with "…"`);
        const kept = cutTitle.slice(0, -1);
        const boundaries = new Set<number>([0]);
        let at = 0;
        for (const part of seg.segment(title)) { at += part.segment.length; boundaries.add(at); }
        assert(title.startsWith(kept) && boundaries.has(kept.length), `${label} pad ${pad}: the cut falls inside a character (kept ${kept.length} code units)`);
      }
    }
    const topic = payload.topicFor('nr-clx7stateid');
    assert(/^[A-Za-z0-9_-]{32}$/.test(topic) && topic === payload.topicFor('nr-clx7stateid') && topic !== payload.topicFor('nr-clx7stateie'), `topic ${topic}`);
    assert(topic === crypto.createHash('sha256').update('nr-clx7stateid').digest('base64url').slice(0, 32), 'not the SHA-256 of the tag');
    assert(!topic.includes('clx7') && !topic.includes('nr-'), `the topic carries the tag: ${topic}`);
  });

  await check('W2 the lifetime: reminder 1 h, alert 24 h, briefing 3 h, the notices 24 h, the test 10 min; an alert stops at its event start; a scheduled kind (reminder, alert, briefing, reconnect) stops at the next pause window, asked over its own lifetime; the partner notices and the test never ask; never above a day, never below a second', async () => {
    reset();
    assert(show(send.PUSH_LIFETIME_S) === show({ reminder: 3600, alert: 86400, briefing: 10800, 'partner-accepted': 86400, 'partner-done': 86400, reconnect: 86400, test: 600 }), `lifetimes ${show(send.PUSH_LIFETIME_S)}`);
    assert(show(send.PUSH_URGENCY) === show({ reminder: 'high', alert: 'high', briefing: 'normal', 'partner-accepted': 'normal', 'partner-done': 'low', reconnect: 'normal', test: 'normal' }), `urgency ${show(send.PUSH_URGENCY)}`);
    assert(show(send.PAUSED_KINDS) === show(['reminder', 'alert', 'briefing', 'reconnect']), `paused kinds ${show(send.PAUSED_KINDS)}`);
    for (const [kind, want] of Object.entries(send.PUSH_LIFETIME_S as Record<string, number>)) {
      const ttl = await send.pushTtlSeconds(USER, kind, T0); // once: each call asks the pause once
      assert(ttl === want, `${kind}: ${ttl}`);
    }
    assert(show(pauseAsks.map((a) => [a.withinMs, a.from])) === show([[3_600_000, T0.toISOString()], [86_400_000, T0.toISOString()], [10_800_000, T0.toISOString()], [86_400_000, T0.toISOString()]]), `asked ${show(pauseAsks)}`);
    assert(await send.pushTtlSeconds(USER, 'alert', T0, new Date(T0.getTime() + 30 * 60_000)) === 1800, 'an alert stops at its event');
    assert(await send.pushTtlSeconds(USER, 'alert', T0, new Date(T0.getTime() + 3 * DAY)) === 86400, 'at most a day');
    assert(await send.pushTtlSeconds(USER, 'alert', T0, new Date(T0.getTime() - 60_000)) === 1, 'an event already started: one second');
    pauseAnswer = new Date(T0.getTime() + 20 * 60_000);
    assert(await send.pushTtlSeconds(USER, 'reminder', T0) === 1200 && await send.pushTtlSeconds(USER, 'briefing', T0) === 1200, 'stops at the window');
    pauseAsks.length = 0;
    assert(await send.pushTtlSeconds(USER, 'partner-done', T0) === 86400 && await send.pushTtlSeconds(USER, 'partner-accepted', T0) === 86400 && await send.pushTtlSeconds(USER, 'test', T0) === 600, 'the notices are not paused');
    assert(pauseAsks.length === 0, `the notices asked the pause: ${show(pauseAsks)}`);
    assert(send.MAX_PUSH_TTL_S === 86400 && Object.values(send.PUSH_LIFETIME_S as Record<string, number>).every((s) => s <= 86400), 'a lifetime over a day');
  });

  await check('W3 a send: every device gets a POST built by web-push and sent by fetchWithRetry, with TTL, Urgency, Topic, aes128gcm and our VAPID header (no Content-Length of our own); its body decrypts with that device\'s keys to the payload; the result and one log line count the devices', async () => {
    reset();
    const result = await send.sendWebPush(USER, MESSAGE, T0);
    assert(show(result) === show({ sent: 2, total: 2, retriable: false }), `result ${show(result)}`);
    assert(pushes.length === 2 && pushesTo(FCM).length === 1 && pushesTo(APPLE).length === 1, `pushes ${pushes.map((p) => p.url.slice(0, 30))}`);
    const want = payload.buildPushPayload(MESSAGE);
    for (const push of pushes) {
      const h = push.headers;
      assert(push.method === 'POST', `method ${push.method}`);
      assert(push.redirect === 'manual', `redirect ${push.redirect}: a push service's 3xx must not be followed (the allow-list covers only the first hop)`);
      assert(h.get('ttl') === '3600' && h.get('urgency') === 'high' && h.get('topic') === payload.topicFor(MESSAGE.tag), `headers ${show([...h.keys()])} ttl ${h.get('ttl')} urgency ${h.get('urgency')}`);
      assert(h.get('content-encoding') === 'aes128gcm' && h.get('content-type') === 'application/octet-stream' && !h.has('content-length'), `encoding headers ${show([...h.entries()].filter(([k]) => k !== 'authorization'))}`);
      assert(decrypt(push) === want, 'the body does not decrypt to the payload');
      const vapid = vapidOf(h.get('authorization'));
      assert(vapid.ok && vapid.key === VAPID.publicKey && vapid.claims.sub === 'mailto:privacy@famcal.bot' && vapid.claims.aud === new URL(push.url).origin, `VAPID ${show(vapid.claims)}`);
      assert(vapid.claims.exp > Date.now() / 1000 && vapid.claims.exp <= Date.now() / 1000 + 86400, `exp ${vapid.claims.exp}`);
    }
    assert(show(sendLines()) === show(['[push] user 7: reminder sent to 2 of 2 devices']), `log ${show(logs)}`);
    assert(pauseAsks.length === 1 && pauseAsks[0].withinMs === 3_600_000, `the pause asked ${show(pauseAsks)}`);
  });

  await check('W4 the answers: 200 and 202 are sent; 404 and 410 delete the device; 429 then 201 is retried and sent; 503 to the end and no answer to the end are retriable; a Retry-After over 10 s fails at once (retriable); one device sent and one failing is not retriable; 400 and 413 are reported; 401 and 403 are reported once a day per device', async () => {
    reset();
    answers.set(FCM, [200]); answers.set(APPLE, [202]);
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 2, total: 2, retriable: false }), 'any 2xx');
    reset();
    answers.set(FCM, [404]); answers.set(APPLE, [410]);
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 2, retriable: false }) && show([...gone].sort()) === show(['dev-apple', 'dev-fcm']), `gone ${show(gone)}`);
    assert(captured.length === 0 && pushes.length === 2, `a gone device is no error, and is not retried: ${show(captured)}, ${pushes.length} pushes`);
    reset();
    devices = [D1];
    answers.set(FCM, [429, 201]);
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 1, total: 1, retriable: false }) && pushesTo(FCM).length === 2, `429 then 201: ${pushesTo(FCM).length} pushes`);
    reset();
    answers.set(FCM, [503, 503, 503, 503]); answers.set(APPLE, [500, 502, 503, 504]);
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 2, retriable: true }) && count(pushes) === 8, `5xx to the end: ${pushes.length} pushes`);
    assert(logs.filter((l) => /^\[push\] user 7: reminder to device dev-(fcm|apple) not delivered \(gave up after 3 retries/.test(l)).length === 2, `the give-up lines ${show(logs)}`);
    reset();
    answers.set(FCM, Array.from({ length: 4 }, () => new TypeError('fetch failed'))); answers.set(APPLE, Array.from({ length: 4 }, () => new TypeError('fetch failed')));
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 2, retriable: true }), 'no answer to the end');
    reset();
    devices = [D1];
    answers.set(FCM, [{ status: 429, retryAfter: '30' }]);
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 1, retriable: true }) && count(pushes) === 1, `Retry-After 30 s: ${pushes.length} pushes`);
    reset();
    answers.set(APPLE, [503, 503, 503, 503]);
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 1, total: 2, retriable: false }), 'one took it');
    for (const status of [400, 413]) {
      reset();
      devices = [D1];
      answers.set(FCM, [status]);
      assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 1, retriable: false }) && count(pushes) === 1 && count(gone) === 0, `${status}`);
      assert(count(captured) === 1 && captured[0].context === 'push-send' && captured[0].extra.status === status && captured[0].extra.device_id === 'dev-fcm', `${status} reported: ${show(captured)}`);
    }
    for (const status of [307, 308]) {
      reset();
      devices = [D1];
      answers.set(FCM, [status]);
      assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 1, retriable: false }) && count(pushes) === 1 && count(gone) === 0, `a ${status} redirect is refused, not followed or retried`);
      assert(count(captured) === 1 && captured[0].extra.status === status, `${status} reported: ${show(captured)}`);
    }
    reset();
    devices = [D1];
    answers.set(FCM, [401, 403, 401]);
    await send.sendWebPush(USER, MESSAGE, T0);
    await send.sendWebPush(USER, MESSAGE, new Date(T0.getTime() + 60_000));
    assert(count(captured) === 1 && captured[0].extra.status === 401, `once a day: ${show(captured)}`);
    assert(logs.filter((l) => l.startsWith('[push] user 7: reminder to device dev-fcm: refused (40')).length === 2, `each refusal logged: ${show(logs)}`);
    await send.sendWebPush(USER, MESSAGE, new Date(T0.getTime() + 25 * HOUR));
    assert(count(captured) === 2, `the next day reports again: ${show(captured)}`);
  });

  await check('W5 the VAPID header: one per push service (its origin is the audience), the same one for an hour, a new one after it', async () => {
    reset();
    const authOf = (url: string) => pushesTo(url).map((p) => p.headers.get('authorization'));
    await send.sendWebPush(USER, MESSAGE, T0);
    await send.sendWebPush(USER, MESSAGE, new Date(T0.getTime() + 59 * 60_000));
    await send.sendWebPush(USER, MESSAGE, new Date(T0.getTime() + 61 * 60_000));
    const [fcm1, fcm2, fcm3] = authOf(FCM);
    const [apple1, apple2, apple3] = authOf(APPLE);
    assert(fcm1 === fcm2 && apple1 === apple2, 'not kept for the hour');
    assert(fcm1 !== apple1 && vapidOf(fcm1).claims.aud === 'https://fcm.googleapis.com' && vapidOf(apple1).claims.aud === 'https://web.push.apple.com', 'one per push service');
    assert(fcm3 !== fcm1 && apple3 !== apple1 && vapidOf(fcm3).ok && vapidOf(apple3).ok, 'not made anew after the hour');
    assert(!/setVapidDetails\(|vapidDetails\s*:/.test(read('src/services/web-push/send.ts')), 'send.ts gives web-push the keys (it would sign a new token every call)');
  });

  await check('W6 push off, no devices, a refused stored key, a failed device read: no keys sends nothing and reads nothing; no devices sends nothing (0 of 0); a device whose key the library refuses is reported and the others go; a failed read is retriable and reported by its kind only; none throws', async () => {
    reset();
    delete process.env.VAPID_PRIVATE_KEY;
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 0, retriable: false }) && pushes.length === 0 && deviceReads === 0, `push off: ${pushes.length} pushes, ${deviceReads} reads`);
    assert(logs.includes('[push] user 7: reminder not sent: browser notifications are off (no VAPID keys)'), `push off log ${show(logs)}`);
    reset();
    devices = [];
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 0, retriable: false }) && pushes.length === 0 && pauseAsks.length === 0, 'no devices');
    assert(show(sendLines()) === show(['[push] user 7: reminder sent to 0 of 0 devices']), `no devices log ${show(logs)}`);
    reset();
    devices = [{ id: 'dev-bad', endpoint: `${FCM}x`, p256dh: 'abc', auth: S1.auth }, D2];
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 1, total: 2, retriable: false }) && count(pushes) === 1, 'a bad stored key');
    assert(captured.some((c) => c.context === 'push-send' && c.extra.device_id === 'dev-bad' && c.extra.purpose === 'build'), `reported ${show(captured)}`);
    reset();
    readFails = true;
    assert(show(await send.sendWebPush(USER, MESSAGE, T0)) === show({ sent: 0, total: 0, retriable: true }) && pushes.length === 0, 'a failed read');
    assert(logs.includes('[push] user 7: reminder not sent: PrismaClientUnknownRequestError') && captured.some((c) => c.context === 'push-send' && c.extra.user_id === 7), `read failure ${show(logs)} ${show(captured)}`);
  });

  await check('W9 onlyEndpoint (ruling R1): a send for one endpoint goes to that device alone (one POST, "sent to 1 of 1 devices"); an endpoint the account does not hold sends nothing ("0 of 0", no push, no TTL work); without it every device gets it', async () => {
    reset();
    const one = await send.sendWebPush(USER, { ...MESSAGE, kind: 'test', onlyEndpoint: APPLE }, T0);
    assert(show(one) === show({ sent: 1, total: 1, retriable: false }), `result ${show(one)}`);
    assert(count(pushes) === 1 && count(pushesTo(APPLE)) === 1 && count(pushesTo(FCM)) === 0, `pushes ${show(pushes.map((p) => p.url.slice(0, 30)))}`);
    assert(decrypt(pushes[0]) === payload.buildPushPayload({ ...MESSAGE, kind: 'test' }), 'the body does not decrypt to the payload');
    assert(show(sendLines()) === show(['[push] user 7: test sent to 1 of 1 devices']), `log ${show(logs)}`);
    reset();
    const none = await send.sendWebPush(USER, { ...MESSAGE, kind: 'test', onlyEndpoint: `${FCM}-other` }, T0);
    assert(show(none) === show({ sent: 0, total: 0, retriable: false }) && count(pushes) === 0, `unknown endpoint: ${show(none)}, ${count(pushes)} pushes`);
    assert(show(sendLines()) === show(['[push] user 7: test sent to 0 of 0 devices']), `log ${show(logs)}`);
    reset();
    const all = await send.sendWebPush(USER, { ...MESSAGE, kind: 'test' }, T0);
    assert(show(all) === show({ sent: 2, total: 2, retriable: false }) && count(pushes) === 2, `without onlyEndpoint: ${show(all)}`);
  });

  await check('W7 the code and the rules: send.ts builds with generateRequestDetails and sends with fetchWithRetry (never sendNotification, never the Google policy); web-push 3.6.7 and @types/web-push 3.6.4 pinned exact; CLAUDE.md\'s Google rule and third-party rule, and fetch-retry.ts\'s header, send every push service, FCM included, through fetchWithRetry', () => {
    const code = read('src/services/web-push/send.ts');
    const problems: string[] = [];
    if (!/\bgenerateRequestDetails\(/.test(code) || !/\bfetchWithRetry\(/.test(code)) problems.push('send.ts does not build with generateRequestDetails and send with fetchWithRetry');
    if (/\bsendNotification\b/.test(code)) problems.push('send.ts names sendNotification (web-push\'s own sender bypasses the retry loop)');
    if (/google-retry|googleFetch/.test(code)) problems.push('send.ts uses the Google policy');
    const pkg = JSON.parse(read('package.json'));
    if (pkg.dependencies?.['web-push'] !== '3.6.7') problems.push(`web-push is ${pkg.dependencies?.['web-push']}`);
    if (pkg.devDependencies?.['@types/web-push'] !== '3.6.4') problems.push(`@types/web-push is ${pkg.devDependencies?.['@types/web-push']}`);
    const lines = read('CLAUDE.md').split('\n');
    const google = lines.find((l) => l.startsWith('- Every call to Google retries')) ?? '';
    const third = lines.find((l) => l.startsWith('- Every call to a third party other than Google')) ?? '';
    for (const word of ['`fcm.googleapis.com`', '`fetchWithRetry`']) if (!google.includes(word)) problems.push(`the Google rule does not name ${word}`);
    for (const word of ['every browser push service, FCM included', '`sendWebPush`', 'src/services/web-push/send.ts']) if (!third.includes(word)) problems.push(`the third-party rule does not name ${word}`);
    const header = read('src/utils/fetch-retry.ts').split('*/')[0];
    if (!/push service/.test(header) || !/FCM/.test(header)) problems.push('fetch-retry.ts\'s header does not name the push services');
    assert(problems.length === 0, problems.join('; '));
  });

  await check('W8 no console line or Sentry field of the run holds an endpoint, a push service token, a key, the private VAPID key, the title or the body', () => {
    const text = show(everyLog) + show(everyCapture);
    const secrets = [FCM, APPLE, 'dQw4w9WgXcQ', 'QGuQyavXutnMH7', S1.p256dh, S1.auth, S2.p256dh, S2.auth, VAPID.privateKey, TITLE, BODY];
    const found = secrets.filter((s) => text.includes(s));
    assert(found.length === 0, `leaked: ${found.map((s) => s.slice(0, 16)).join(', ')}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
