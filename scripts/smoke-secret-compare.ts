// Smoke test for the shared-secret compares (secret rotation spec, section e.1).
//
// - matchesSecret (src/lib/secret-compare.ts) compares sha256 digests in constant time and
//   never matches an unset or empty expected value.
// - The cron routes (withCronHandler) take CRON_SECRET only as `Authorization: Bearer`.
//   With CRON_SECRET='' a bare `?secret=` opened every cron route, and a secret in a URL
//   ends up in logs.
// - /api/subscription/usage, /api/execute-command and /api/webhook (the Meta verify token
//   and the Telegram secret header) compare through matchesSecret. With
//   WHATSAPP_WEBHOOK_VERIFY_TOKEN='' an empty hub.verify_token passed the Meta check.
//
// Real: secret-compare, cron-handler, the usage route and the webhook route. Faked at the
// boundaries: Prisma and Redis (recorded, never answered), error capture, the subscription
// service, the messaging index and the webhook handlers. No network, no DB.
//
// Run: bash <scratchpad>/run-smoke.sh scripts/smoke-secret-compare.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const env = process.env as Record<string, string | undefined>;

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

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

/** Every Prisma or Redis access, by path ("prisma.user.findUnique"). */
const dataCalls: string[] = [];
function recording(name: string): Row {
  return new Proxy({} as Row, {
    get: (_t, model) => {
      if (typeof model !== 'string' || model === 'then') return undefined;
      return new Proxy(async () => null, {
        get: (_f, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return async () => { dataCalls.push(`${name}.${model}.${method}`); return null; };
        },
        apply: () => { dataCalls.push(`${name}.${model}()`); return Promise.resolve(null); },
      });
    },
  });
}

const captured: string[] = [];
const featureChecks: unknown[][] = [];
const handled: string[] = [];
function installStubs() {
  stub('src/utils/prisma.ts', { prisma: recording('prisma'), withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: recording('redis') });
  const capture = (_err: unknown, context: string) => { captured.push(context); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/services/subscription-service.ts', {
    checkFeatureAccess: async (...args: unknown[]) => { featureChecks.push(args); return { allowed: true }; },
  });
  const MessagingPlatform = { TELEGRAM: 'telegram', WHATSAPP: 'whatsapp' };
  stub('src/services/messaging/index.ts', {
    MessagingPlatform,
    detectPlatform: (req: { body: Row }) =>
      req.body?.object === 'whatsapp_business_account' ? MessagingPlatform.WHATSAPP : MessagingPlatform.TELEGRAM,
  });
  stub('src/services/webhook-handlers.ts', {
    handleTelegramWebhook: async () => { handled.push('telegram'); },
    handleWhatsAppWebhook: async () => { handled.push('whatsapp'); },
  });
}

/** Source files under a folder, as repo-relative paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(child);
    }
  };
  walk(dir);
  return out;
}

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');
  const req = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    new NextRequest(`http://localhost${url}`, init);

  // Missing before the change: each check that uses it then fails on its own.
  const compare = await load('src/lib/secret-compare.ts').catch(() => ({} as Row));

  await check('#1 matchesSecret: equal non-empty strings only; an unset or empty expected value, or a missing given value, never matches; no throw on a length mismatch', () => {
    const m = compare.matchesSecret;
    assert(typeof m === 'function', 'matchesSecret is not exported from src/lib/secret-compare.ts');
    const cases: [unknown, unknown, boolean][] = [
      ['c', 'c', true],
      ['סוד-1', 'סוד-1', true],
      ['c', 'C', false],
      ['c', 'cc', false],
      ['a-much-longer-given-value', 'c', false],
      ['', '', false],
      [null, '', false],
      [undefined, undefined, false],
      ['', 'c', false],
      [null, 'c', false],
      [undefined, 'c', false],
      ['c', '', false],
      ['c', null, false],
      ['c', undefined, false],
      [1, '1', false],
      [{ toString: () => 'c' }, 'c', false],
    ];
    const wrong = cases.filter(([given, expected, want]) => m(given, expected) !== want);
    assert(wrong.length === 0, `wrong results: ${show(wrong.map(([g, e, w]) => ({ given: String(g), expected: String(e), want: w })))}`);
  });

  const { withCronHandler } = await load('src/lib/cron-handler.ts');
  const cronCalls: string[] = [];
  const runCron = async (url: string, headers?: Record<string, string>) => {
    const res: Response = await withCronHandler(req(url, { method: 'POST', headers }), {
      jobName: 'Smoke Job',
      handler: async (_r: unknown, searchParams: URLSearchParams) => {
        cronCalls.push(searchParams.get('window') ?? '');
        return { success: true, message: 'ran' };
      },
    });
    return res.status;
  };

  await check('#2 cron: with CRON_SECRET unset or empty, no request opens a cron route (no header, ?secret=, an empty Bearer)', async () => {
    cronCalls.length = 0;
    const saved = env.CRON_SECRET;
    try {
      delete env.CRON_SECRET;
      const unsetNoAuth = await runCron('/api/reminders');
      const unsetEmptyQuery = await runCron('/api/reminders?secret=');
      env.CRON_SECRET = '';
      const emptyQuery = await runCron('/api/reminders?secret=');
      const emptyBearer = await runCron('/api/reminders', { authorization: 'Bearer ' });
      const statuses = { unsetNoAuth, unsetEmptyQuery, emptyQuery, emptyBearer };
      assert(Object.values(statuses).every(s => s === 401), `statuses ${show(statuses)}`);
      assert(cronCalls.length === 0, `the handler ran ${cronCalls.length} time(s)`);
    } finally {
      env.CRON_SECRET = saved;
    }
  });

  await check('#3 cron: CRON_SECRET only as `Authorization: Bearer`; ?secret=c, a bare header value and a wrong Bearer get 401; Bearer c runs the handler with its query', async () => {
    cronCalls.length = 0;
    const saved = env.CRON_SECRET;
    try {
      env.CRON_SECRET = 'c';
      const query = await runCron('/api/reminders?secret=c');
      const bare = await runCron('/api/reminders', { authorization: 'c' });
      const wrong = await runCron('/api/reminders', { authorization: 'Bearer wrong' });
      assert(query === 401 && bare === 401 && wrong === 401, `query ${query}, bare ${bare}, wrong ${wrong}`);
      assert(cronCalls.length === 0, `the handler ran on a refused request: ${show(cronCalls)}`);
      const good = await runCron('/api/reminders?window=7', { authorization: 'Bearer c' });
      assert(good === 200, `Bearer c: ${good}`);
      assert(show(cronCalls) === show(['7']), `handler calls ${show(cronCalls)}`);
    } finally {
      env.CRON_SECRET = saved;
    }
  });

  await check('#4 /api/subscription/usage: CRON_SECRET empty and ?secret= empty is 401 with no lookup; the right secret still answers', async () => {
    featureChecks.length = 0;
    const saved = env.CRON_SECRET;
    try {
      const { GET } = await load('app/api/subscription/usage/route.ts');
      env.CRON_SECRET = '';
      const open = await GET(req('/api/subscription/usage?user_id=1&feature=reminders&secret='));
      assert(open.status === 401, `empty secret: ${open.status}`);
      assert(featureChecks.length === 0, `checkFeatureAccess ran: ${show(featureChecks)}`);
      assert(dataCalls.length === 0, `data calls on a refused request: ${show(dataCalls)}`);
      env.CRON_SECRET = 'c';
      const wrong = await GET(req('/api/subscription/usage?user_id=1&feature=reminders&secret=x'));
      const good = await GET(req('/api/subscription/usage?user_id=1&feature=reminders&secret=c'));
      assert(wrong.status === 401 && good.status === 200, `wrong ${wrong.status}, good ${good.status}`);
      assert(show(featureChecks) === show([[1, 'reminders']]), `checkFeatureAccess calls ${show(featureChecks)}`);
    } finally {
      env.CRON_SECRET = saved;
    }
  });

  await check('#5 GET /api/webhook (Meta verify): an empty WHATSAPP_WEBHOOK_VERIFY_TOKEN matches nothing; the right token echoes the challenge', async () => {
    const saved = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    try {
      const { GET } = await load('app/api/webhook/route.ts');
      const verify = (token?: string) =>
        GET(req(`/api/webhook?hub.mode=subscribe&hub.challenge=ch-1${token === undefined ? '' : `&hub.verify_token=${token}`}`));
      env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = '';
      const empty = await verify('');
      delete env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
      const unset = await verify();
      env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'vt';
      const wrong = await verify('vX');
      const good = await verify('vt');
      assert(empty.status === 403 && unset.status === 403 && wrong.status === 403,
        `empty ${empty.status}, unset ${unset.status}, wrong ${wrong.status}`);
      assert(good.status === 200 && (await good.text()) === 'ch-1', `good ${good.status}`);
    } finally {
      env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = saved;
    }
  });

  await check('#6 POST /api/webhook (Telegram): the secret header is compared with matchesSecret; right handled, wrong or missing 401', async () => {
    handled.length = 0;
    const saved = env.TELEGRAM_WEBHOOK_SECRET;
    try {
      const src = readSource('app/api/webhook/route.ts');
      assert(/matchesSecret\(\s*providedSecret\s*,\s*webhookSecret\s*\)/.test(src), 'the Telegram header is not compared with matchesSecret(providedSecret, webhookSecret)');
      const { POST } = await load('app/api/webhook/route.ts');
      env.TELEGRAM_WEBHOOK_SECRET = 'tg-s1';
      const body = JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 9 }, text: 'hi' } });
      const post = (headers: Record<string, string>) => POST(req('/api/webhook', { method: 'POST', headers, body }));
      const missing = await post({});
      const wrong = await post({ 'x-telegram-bot-api-secret-token': 'tg-s2' });
      assert(missing.status === 401 && wrong.status === 401, `missing ${missing.status}, wrong ${wrong.status}`);
      assert(handled.length === 0, `handled a refused update: ${show(handled)}`);
      assert(captured.length === 0, `a refused update was captured as an error: ${show(captured)}`);
      const good = await post({ 'x-telegram-bot-api-secret-token': 'tg-s1' });
      assert(good.status === 200 && show(handled) === show(['telegram']), `good ${good.status}, handled ${show(handled)}`);
    } finally {
      env.TELEGRAM_WEBHOOK_SECRET = saved;
    }
  });

  await check('#7 no code in app/ or src/ compares a secret env value with === or !==; the four call sites use matchesSecret', () => {
    // A check against a literal, undefined or null (is it set?) is not a secret compare
    const plainCompare = [
      /[!=]==\s*process\.env\.[A-Z0-9_]*(SECRET|TOKEN|KEY)\b/,
      /process\.env\.[A-Z0-9_]*(SECRET|TOKEN|KEY)\b\s*[!=]==\s*(?![\s'"`]|undefined\b|null\b)/,
      /[!=]==\s*webhookSecret\b/,
    ];
    const hits = [...sourceFiles('app'), ...sourceFiles('src')]
      .filter(f => plainCompare.some(re => re.test(readSource(f))));
    assert(hits.length === 0, `plain compares in ${hits.join(', ')}`);
    const sites = ['src/lib/cron-handler.ts', 'app/api/subscription/usage/route.ts', 'app/api/execute-command/route.ts', 'app/api/webhook/route.ts'];
    const missing = sites.filter(f => !/matchesSecret\(/.test(readSource(f)));
    assert(missing.length === 0, `no matchesSecret in ${missing.join(', ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
