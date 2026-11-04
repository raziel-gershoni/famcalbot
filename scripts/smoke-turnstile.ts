// Smoke test for Cloudflare Turnstile on the email-code form (6c-1 plan, Task 3; spec
// docs/superpowers/specs/2026-11-03-web-sign-up-design.md §2.4, §3.1, §8 "Turnstile"): src/services/web-signin/turnstile.ts
// and POST /api/auth/email/request's check.
//
//  - T1 unconfigured (neither variable, or only one of the two): no check, no site key for the page, and the request
//    route answers as in 6b with nothing sent to Cloudflare
//  - T2 a pass: one siteverify POST with the secret, the token, the client's own address (x-real-ip as it came, IPv6
//    whole, none without the header) and a UUID idempotency key; then the limits are counted and the answer is
//    { ok: true } with the flow cookie
//  - T3 every failure answers { ok: false, error: 'check' } (403) before anything is counted, looked up or mailed, with
//    no flow cookie: no token, an empty one, one that is no text, one over 2048 characters (none of them asks
//    Cloudflare), a refused token, timeout-or-duplicate, another hostname, another or no action, a 5xx or no answer to
//    the end of the retries, an answer that is not JSON, a 400, and a secret Cloudflare refuses (reported)
//  - T4 a retry repeats the request's idempotency key, another request gets a new one; the hostname must be the app's
//    (getBaseUrl): verifyTurnstile never sees the request
//  - T5 no console line or error report holds the token or the secret; the Sentry scrubber drops a body's token, and the
//    console scrubber covers TURNSTILE_SECRET (…_SECRET)
//
// Real: the request route, turnstile.ts, fetch-retry, whole-json, the limits, the flow, the client address, the Sentry
// and console scrubbers. Faked at the boundaries (scripts/lib/signin-world.ts): Prisma, Redis, error capture, Next's
// after(), and fetch (siteverify scripted, Resend recorded, anything else blocked). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-turnstile

import {
  assert, body, captured, check, drainAfter, everyCapture, everyLog, installSigninWorld, load, mails, prismaCalls,
  redisStore, report, request, resetWorld, show, siteverifyAnswer, siteverifyCalls, world, type Row,
} from './lib/signin-world';

const SITE_KEY = '1x00000000000000000000AA';
const SECRET = 'smoke-turnstile-secret-not-real-0001';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX-smoke-7f3a9c';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function configure(on: { siteKey?: boolean; secret?: boolean }) {
  if (on.siteKey) process.env.TURNSTILE_SITE_KEY = SITE_KEY;
  else delete process.env.TURNSTILE_SITE_KEY;
  if (on.secret) process.env.TURNSTILE_SECRET = SECRET;
  else delete process.env.TURNSTILE_SECRET;
}

async function main() {
  configure({});
  await installSigninWorld();
  const retry = await load('src/utils/fetch-retry.ts');
  retry.__useRetryForTests({ sleep: async () => undefined, random: () => 0 });
  const turnstile = await load('src/services/web-signin/turnstile.ts');
  const route = await load('app/api/auth/email/request/route.ts');
  const { SIGNIN_COOKIE_NAME } = await load('src/services/web-signin/flow.ts');

  let seq = 0;
  /** A code request; each one names its own address, so the per-address minute never holds one back. */
  const ask = async (extra: Row, o: { ip?: string | null } = {}) => {
    const res: Row = await route.POST(request('/api/auth/email/request', { body: { email: `person${++seq}@example.com`, locale: 'en', ...extra }, ip: o.ip }));
    return { status: res.status as number, body: await body(res as Response), cookie: (res.cookies.get(SIGNIN_COOKIE_NAME)?.value as string | undefined) ?? null };
  };
  const limitKeys = () => [...redisStore.keys()].filter((k) => k.startsWith('signin:lim:'));

  await check('T1 unconfigured (neither variable, or only one): no check and no site key; the request route answers as before and asks Cloudflare nothing', async () => {
    for (const on of [{}, { siteKey: true }, { secret: true }]) {
      resetWorld();
      configure(on);
      assert(turnstile.turnstileConfigured() === false && turnstile.turnstileSiteKey() === null, `${show(on)}: configured`);
      const r = await ask({});
      assert(r.status === 200 && show(r.body) === show({ ok: true }) && r.cookie, `${show(on)}: ${r.status} ${show(r.body)}`);
      assert(siteverifyCalls.length === 0, `${show(on)}: Cloudflare was asked`);
    }
    configure({ siteKey: true, secret: true });
    assert(turnstile.turnstileConfigured() === true && turnstile.turnstileSiteKey() === SITE_KEY, 'both set');
    assert(turnstile.TURNSTILE_ACTION === 'email-code' && turnstile.SITEVERIFY_URL === 'https://challenges.cloudflare.com/turnstile/v0/siteverify', 'the action or the endpoint');
  });

  await check('T2 a pass: one siteverify POST with the secret, the token, the client\'s own address (IPv6 whole; none without the header) and a UUID idempotency key; then the limits and { ok: true } with the flow', async () => {
    configure({ siteKey: true, secret: true });
    resetWorld();
    const r = await ask({ token: TOKEN });
    assert(r.status === 200 && show(r.body) === show({ ok: true }) && r.cookie, `${r.status} ${show(r.body)}`);
    assert(siteverifyCalls.length === 1, `calls ${siteverifyCalls.length}`);
    const form = siteverifyCalls[0].form;
    assert(form.get('secret') === SECRET && form.get('response') === TOKEN && form.get('remoteip') === '203.0.113.9', `the form's fields: ${show([...form.keys()])}`);
    assert(UUID.test(form.get('idempotency_key') ?? ''), 'no UUID idempotency key');
    assert(limitKeys().length > 0, 'the limits were not counted after the pass');
    resetWorld();
    await ask({ token: TOKEN }, { ip: '2001:db8:1:2::9' });
    assert(siteverifyCalls[0]?.form.get('remoteip') === '2001:db8:1:2::9', `IPv6: ${siteverifyCalls[0]?.form.get('remoteip')}`);
    resetWorld();
    const none = await ask({ token: TOKEN }, { ip: null });
    assert(none.body.ok === true && siteverifyCalls[0] && !siteverifyCalls[0].form.has('remoteip'), 'remoteip without an address');
  });

  await check('T3 every failure answers { ok: false, error: "check" } (403) with no flow cookie, before anything is counted, looked up or mailed; a token that is none, empty, not text or over 2048 characters asks Cloudflare nothing; a refused secret is reported', async () => {
    configure({ siteKey: true, secret: true });
    const four = <T>(x: T): T[] => [x, x, x, x];
    const cases: [string, unknown, (Row | number | string | Error)[], number][] = [
      ['no token', undefined, [], 0],
      ['an empty token', '', [], 0],
      ['a token that is not text', 12345, [], 0],
      ['a token over 2048 characters', 'x'.repeat(2049), [], 0],
      ['a refused token', TOKEN, [siteverifyAnswer({ success: false, 'error-codes': ['invalid-input-response'] })], 1],
      ['timeout-or-duplicate', TOKEN, [siteverifyAnswer({ success: false, 'error-codes': ['timeout-or-duplicate'] })], 1],
      ['another hostname', TOKEN, [siteverifyAnswer({ hostname: 'famcal.bot.evil.example' })], 1],
      ['another action', TOKEN, [siteverifyAnswer({ action: 'login' })], 1],
      ['no action', TOKEN, [siteverifyAnswer({ action: undefined })], 1],
      ['a 5xx to the end of the retries', TOKEN, four(503), 4],
      ['no answer to the end of the retries', TOKEN, four(new TypeError('fetch failed')), 4],
      ['an answer that is not JSON', TOKEN, four('{"success":tr'), 4],
      ['a 400 (not retried)', TOKEN, [400], 1],
      ['a secret Cloudflare refuses', TOKEN, [siteverifyAnswer({ success: false, 'error-codes': ['invalid-input-secret'] })], 1],
    ];
    const problems: string[] = [];
    for (const [label, token, answers, calls] of cases) {
      resetWorld();
      world.siteverify = [...answers];
      const r = await ask(token === undefined ? {} : { token });
      if (r.status !== 403 || show(r.body) !== show({ ok: false, error: 'check' }) || r.cookie !== null) problems.push(`${label}: ${r.status} ${show(r.body)} cookie ${r.cookie}`);
      if (siteverifyCalls.length !== calls) problems.push(`${label}: ${siteverifyCalls.length} siteverify calls, want ${calls}`);
      if (limitKeys().length !== 0) problems.push(`${label}: counted ${show(limitKeys())}`);
      await drainAfter();
      if (mails.length !== 0 || prismaCalls.length !== 0) problems.push(`${label}: mailed ${mails.length}, queried ${show(prismaCalls)}`);
      if (label === 'a secret Cloudflare refuses' && !captured.some((c) => c.context === 'turnstile')) problems.push(`${label}: not reported (${show(captured)})`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('T4 a retry repeats the request\'s idempotency key and another request gets a new one; the hostname is the app\'s (getBaseUrl), so another base URL refuses famcal.bot\'s answer', async () => {
    configure({ siteKey: true, secret: true });
    resetWorld();
    world.siteverify = [503, siteverifyAnswer()];
    const r = await ask({ token: TOKEN });
    assert(r.body.ok === true, `after a 503 and a pass: ${show(r.body)}`);
    const [first, second] = siteverifyCalls.map((c) => c.form.get('idempotency_key'));
    assert(siteverifyCalls.length === 2 && first && UUID.test(first) && first === second, `the keys ${show([first, second])}`);
    await ask({ token: TOKEN });
    const third = siteverifyCalls[2]?.form.get('idempotency_key');
    assert(third && UUID.test(third) && third !== first, `another request's key ${third}`);
    // verifyTurnstile takes no request, so the hostname it wants can only be the app's
    resetWorld();
    assert(show(await turnstile.verifyTurnstile(TOKEN, null)) === show({ ok: true }), 'famcal.bot on famcal.bot');
    const base = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://staging.famcal.bot';
    try {
      const other = await turnstile.verifyTurnstile(TOKEN, null);
      assert(show(other) === show({ ok: false, why: 'hostname' }), `famcal.bot's answer on staging: ${show(other)}`);
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = base;
    }
  });

  await check('T5 no console line or error report holds the token or the secret; the Sentry scrubber drops a body\'s token; the console scrubber covers TURNSTILE_SECRET', async () => {
    const leakedLines = everyLog.filter((l) => l.includes(TOKEN) || l.includes(SECRET) || l.includes('XXXX.DUMMY'));
    assert(leakedLines.length === 0, `console lines: ${show(leakedLines)}`);
    const leakedReports = everyCapture.filter((c) => show(c).includes(TOKEN) || show(c).includes(SECRET));
    assert(leakedReports.length === 0, `error reports: ${show(leakedReports)}`);
    const { scrubServerEvent } = await load('src/lib/sentry-scrub.ts');
    for (const data of [JSON.stringify({ email: 'x@example.com', locale: 'en', token: TOKEN }), { email: 'x@example.com', locale: 'en', token: TOKEN }]) {
      const event = scrubServerEvent({ request: { url: `https://famcal.bot/api/auth/email/request?token=${TOKEN}`, data } });
      assert(!show(event).includes(TOKEN), `Sentry keeps the token: ${show(event)}`);
    }
    const { secretValues } = await load('src/lib/console-scrub.ts');
    assert(secretValues({ TURNSTILE_SECRET: SECRET, TURNSTILE_SITE_KEY: SITE_KEY }).includes(SECRET), 'the console scrubber misses TURNSTILE_SECRET');
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
