// Smoke test for send to chat on the calendar home (src/lib/command-client.ts, spec §7.2
// and Ruling R5).
//
// The old dashboard's call closes the Mini App whatever the answer (DashboardClient.tsx
// executeCommand: close() in a finally), so a 429 or a 500 vanishes with the app. It
// also closes in a plain browser, since the SDK defines Telegram.WebApp there. sendToChat
// treats a call as Telegram only when readInitData() is non-empty, closes only on a 2xx,
// answers busy on a 429 and failed otherwise, and in a browser stays open with "sent".
// The initData goes in the X-Telegram-Init-Data header, with the body copy as the
// fallback the route also reads.
//
// Faked at the boundaries: fetch (records each call, answers a set status or rejects)
// and the browser window (with and without the Telegram SDK). No network.
//
// The check named [guard] already passes before this task and must keep passing.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-command-client.ts

import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const client = () => load('src/lib/command-client.ts');

const INIT_DATA = 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc';
const USER_ID = 5550001;

type Sent = { url: string; init: Row; body: Row; headers: Record<string, string> };
type Env = { log: string[]; sent: Sent[]; errors: string[] };

/** A fake Telegram.WebApp; close() is recorded in `log` (and throws when asked to). */
function fakeWebApp(log: string[], initData: string, closeThrows = false): Row {
  return {
    initData,
    initDataUnsafe: {},
    version: initData ? '8.0' : '6.0',
    close: () => {
      log.push('close()');
      if (closeThrows) throw new Error('close: not now');
    },
  };
}

/**
 * Runs fn with a fake window (`webApp` null: no SDK at all) and a fake fetch that answers
 * `answer` (a status) or rejects ('reject'). console.error is collected, not printed.
 */
async function scenario(
  o: { webApp?: (log: string[]) => Row | null; hash?: string; answer: number | 'reject' },
  fn: (env: Env) => Promise<void>
): Promise<void> {
  const g = globalThis as Row;
  const env: Env = { log: [], sent: [], errors: [] };
  const had = 'window' in g;
  const prev = { window: g.window, fetch: g.fetch, error: console.error };
  const webApp = o.webApp ? o.webApp(env.log) : null;
  g.window = {
    location: { hash: o.hash ?? '' },
    sessionStorage: { getItem: () => null, setItem: () => undefined },
    ...(webApp ? { Telegram: { WebApp: webApp } } : {}),
  };
  g.fetch = async (input: unknown, init: Row = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
    env.sent.push({ url: String(input), init, body: JSON.parse(String(init.body ?? 'null')), headers });
    env.log.push('fetch');
    if (o.answer === 'reject') throw new TypeError('Failed to fetch');
    const noBody = [204, 205, 304].includes(o.answer);
    return new Response(noBody ? null : JSON.stringify({ success: o.answer < 300 }), {
      status: o.answer,
      headers: { 'content-type': 'application/json' },
    });
  };
  console.error = (...args: unknown[]) => {
    env.errors.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  try {
    await fn(env);
  } finally {
    console.error = prev.error;
    g.fetch = prev.fetch;
    if (had) g.window = prev.window;
    else delete g.window;
  }
}

const inTelegram = (log: string[]) => fakeWebApp(log, INIT_DATA);
/** The SDK as it runs in a plain browser: Telegram.WebApp exists, with no initData. */
const browserSdk = (log: string[]) => fakeWebApp(log, '');

async function main() {
  await check('#1 the five send items, in the sheet\'s order, run exactly the old dashboard\'s five commands', async () => {
    const { SEND_ITEMS, SEND_COMMANDS } = await client();
    assert(show(SEND_ITEMS) === show(['today', 'tomorrow', 'thisWeek', 'nextWeek', 'weather']), `SEND_ITEMS: ${show(SEND_ITEMS)}`);
    const want = show({
      today: { command: 'summary' },
      tomorrow: { command: 'summary', args: 'tmrw' },
      thisWeek: { command: 'lookahead' },
      nextWeek: { command: 'nextweek' },
      weather: { command: 'weather' },
    });
    assert(show(SEND_COMMANDS) === want, `SEND_COMMANDS: ${show(SEND_COMMANDS)}`);
    const src = readSource('app/[locale]/dashboard/DashboardClient.tsx');
    const old = [...src.matchAll(/executeCommand\('(\w+)'(?:, '(\w+)')?\)/g)].map(m => (m[2] ? `${m[1]} ${m[2]}` : m[1]));
    const now = (SEND_ITEMS as string[]).map(i => {
      const c = SEND_COMMANDS[i];
      return c.args ? `${c.command} ${c.args}` : c.command;
    });
    assert(show([...old].sort()) === show([...now].sort()), `old dashboard ${show(old)}, home ${show(now)}`);
  });

  await check('#2 Telegram, 200 and 202: one POST to /api/execute-command with the initData header and the body copy, then close() once', async () => {
    const { sendToChat } = await client();
    for (const status of [200, 202]) {
      await scenario({ webApp: inTelegram, answer: status }, async env => {
        const result = await sendToChat(USER_ID, 'tomorrow', 'he');
        assert(show(result) === show({ outcome: 'closing' }), `${status}: ${show(result)}`);
        assert(show(env.log) === show(['fetch', 'close()']), `${status}: order ${show(env.log)}`);
        assert(env.sent.length === 1, `${status}: ${env.sent.length} requests`);
        const [req] = env.sent;
        assert(req.url === '/api/execute-command', `url ${req.url}`);
        assert(req.init.method === 'POST' && req.init.credentials === 'same-origin', `init ${show({ method: req.init.method, credentials: req.init.credentials })}`);
        assert(show(req.headers) === show({ 'content-type': 'application/json', 'x-telegram-init-data': INIT_DATA }), `headers ${show(req.headers)}`);
        assert(
          show(req.body) === show({ user_id: USER_ID, command: 'summary', args: 'tmrw', language: 'he', initData: INIT_DATA }),
          `body ${show(req.body)}`
        );
      });
    }
  });

  await check('#3 Telegram, 429: busy (try in a minute), and the app stays open', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: inTelegram, answer: 429 }, async env => {
      const result = await sendToChat(USER_ID, 'today', 'en');
      assert(show(result) === show({ outcome: 'busy' }), show(result));
      assert(!env.log.includes('close()'), `closed: ${show(env.log)}`);
    });
  });

  await check('#4 Telegram, 400 / 401 / 403 / 404 / 500 / 503: failed with the status, and the app stays open', async () => {
    const { sendToChat } = await client();
    const wrong: string[] = [];
    for (const status of [400, 401, 403, 404, 500, 503]) {
      await scenario({ webApp: inTelegram, answer: status }, async env => {
        const result = await sendToChat(USER_ID, 'weather', 'ru');
        if (show(result) !== show({ outcome: 'failed', status })) wrong.push(`${status}: ${show(result)}`);
        if (env.log.includes('close()')) wrong.push(`${status}: closed`);
      });
    }
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#5 Telegram, no answer (fetch rejects): failed with status null, logged, and the app stays open', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: inTelegram, answer: 'reject' }, async env => {
      const result = await sendToChat(USER_ID, 'thisWeek', 'en');
      assert(show(result) === show({ outcome: 'failed', status: null }), show(result));
      assert(!env.log.includes('close()'), `closed: ${show(env.log)}`);
      assert(env.errors.some(e => e.includes('Failed to fetch')), `logged: ${show(env.errors)}`);
    });
  });

  await check('#6 a browser with the SDK loaded (initData \'\'): no header, no initData in the body, 200 → sent to WhatsApp, and close() is never called', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: browserSdk, answer: 200 }, async env => {
      const result = await sendToChat(42, 'nextWeek', 'en');
      assert(show(result) === show({ outcome: 'sent', chat: 'whatsapp' }), show(result));
      assert(show(env.log) === show(['fetch']), `calls: ${show(env.log)}`);
      const [req] = env.sent;
      assert(show(req.headers) === show({ 'content-type': 'application/json' }), `headers ${show(req.headers)}`);
      assert(show(req.body) === show({ user_id: 42, command: 'nextweek', language: 'en' }), `body ${show(req.body)}`);
      assert(req.init.credentials === 'same-origin', 'the session cookie would not ride along');
    });
  });

  await check('#7 a browser: 429 → busy, 500 → failed, no answer → failed (null); the page never closes', async () => {
    const { sendToChat } = await client();
    const wrong: string[] = [];
    const cases: [number | 'reject', Row][] = [
      [429, { outcome: 'busy' }],
      [500, { outcome: 'failed', status: 500 }],
      ['reject', { outcome: 'failed', status: null }],
    ];
    for (const [answer, want] of cases) {
      await scenario({ webApp: browserSdk, answer }, async env => {
        const result = await sendToChat(42, 'today', 'he');
        if (show(result) !== show(want)) wrong.push(`${answer}: ${show(result)}`);
        if (env.log.includes('close()')) wrong.push(`${answer}: closed`);
      });
    }
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#8 a browser with no SDK at all: 200 → sent to WhatsApp', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: () => null, answer: 200 }, async env => {
      const result = await sendToChat(42, 'weather', 'en');
      assert(show(result) === show({ outcome: 'sent', chat: 'whatsapp' }), show(result));
      assert(env.sent.length === 1 && !('x-telegram-init-data' in env.sent[0].headers), `headers ${show(env.sent[0]?.headers)}`);
    });
  });

  await check('#9 Telegram with the SDK blocked (initData only in the launch hash): the header from the hash, 200 → sent to the Telegram chat, nothing to close', async () => {
    const { sendToChat } = await client();
    const hash = `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=8.0`;
    await scenario({ webApp: () => null, hash, answer: 200 }, async env => {
      const result = await sendToChat(USER_ID, 'today', 'he');
      assert(show(result) === show({ outcome: 'sent', chat: 'telegram' }), show(result));
      assert(env.sent[0]?.headers['x-telegram-init-data'] === INIT_DATA, `header ${show(env.sent[0]?.headers)}`);
      assert(env.sent[0]?.body.initData === INIT_DATA, `body ${show(env.sent[0]?.body)}`);
    });
  });

  await check('#10 Telegram, a close() that throws: sent to the Telegram chat, logged, and sendToChat does not throw', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: log => fakeWebApp(log, INIT_DATA, true), answer: 200 }, async env => {
      const result = await sendToChat(USER_ID, 'today', 'en');
      assert(show(result) === show({ outcome: 'sent', chat: 'telegram' }), show(result));
      assert(show(env.log) === show(['fetch', 'close()']), `calls: ${show(env.log)}`);
      assert(env.errors.some(e => e.includes('close: not now')), `logged: ${show(env.errors)}`);
    });
  });

  await check('#11 [guard] the old dashboard keeps its own executeCommand, which closes in its finally, and does not use command-client', () => {
    const src = readSource('app/[locale]/dashboard/DashboardClient.tsx');
    assert(src.includes('const executeCommand = async (command: string, args?: string) => {'), 'executeCommand is gone');
    assert(src.includes("await fetch('/api/execute-command', {"), 'the old fetch is gone');
    assert(src.includes('window.Telegram.WebApp.close();'), 'the old close is gone');
    assert(!src.includes('command-client'), 'DashboardClient imports command-client');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
