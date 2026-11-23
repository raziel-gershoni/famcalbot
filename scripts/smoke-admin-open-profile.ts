// Smoke test for the admin's "Open in Telegram" (menu-revamp spec §6, plan Task 4): openProfileFor
// (src/services/admin-open-profile.ts), the route's answer table, the route's guard, and openTelegramLink.
//   - a user with a public username: the t.me link, and nothing is sent to anyone;
//   - a user with none (or a getChat that Telegram refused): one message to the admin's own chat, in the admin's language, with
//     the user's name as an HTML mention (tg://user?id=...), the name escaped, parse_mode HTML;
//   - a user with no Telegram id: notFound, with no Telegram call at all; a send that fails: failed;
//   - the route answers 200 / 404 / 502 from the outcome, and asks verifyAdminAccess before openProfileFor;
//   - no console line holds the name, the username or the message text;
//   - openTelegramLink opens only https://t.me/... links.
// No network, no database: the bot and prisma are fakes passed in.
//
//   npx tsx scripts/smoke-admin-open-profile.ts

import fs from 'node:fs';
import path from 'node:path';
import { tgNoAnswer, tgRefused } from './lib/fake-telegram';

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
const show = (v: unknown) => JSON.stringify(v);

const ROOT = path.resolve(__dirname, '..');
const ADMIN_TG = 5550001;
const ADMIN_ID = 1;
const TARGET_ID = 7;
const TARGET_TG = 7000007;
const NAME = '<b>&"';
const USERNAME = 'alice_fake';

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** A fake Api: getChat answers `chat` (or throws), sendMessage records (or throws). */
function fakeBot(opts: { chat?: Record<string, unknown>; getChatError?: Error; sendError?: Error }) {
  const calls: Call[] = [];
  const bot = {
    getChat: async (params: Record<string, unknown>) => {
      calls.push({ method: 'getChat', params });
      if (opts.getChatError) throw opts.getChatError;
      return opts.chat ?? { id: params.chat_id };
    },
    sendMessage: async (params: Record<string, unknown>) => {
      calls.push({ method: 'sendMessage', params });
      if (opts.sendError) throw opts.sendError;
      return { message_id: 1 };
    },
  };
  return { bot, calls };
}

/** A fake prisma: the admin by Telegram id, the target by database id. */
function fakePrisma(target: { telegramId: bigint | null; name: string } | null, adminLanguage = 'en') {
  return {
    user: {
      findUnique: async (args: { where: { id?: number; telegramId?: bigint } }) => {
        if (args.where.telegramId !== undefined) return BigInt(ADMIN_TG) === args.where.telegramId ? { id: ADMIN_ID, language: adminLanguage } : null;
        if (args.where.id === TARGET_ID) return target;
        return null;
      },
    },
  };
}

// What the run writes to the console, to be searched afterwards
const written: string[] = [];
for (const level of ['log', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]) => void written.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : show(a))).join(' '));
}
const out = (text: string) => process.stdout.write(`${text}\n`);

async function main() {
  const { openProfileFor, openProfileAnswer } = await import('../src/services/admin-open-profile');
  const enMessages = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'));
  const heMessages = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8'));
  const person = { telegramId: BigInt(TARGET_TG), name: NAME };
  const run = (bot: ReturnType<typeof fakeBot>['bot'], target: typeof person | { telegramId: null; name: string } | null, language = 'en') =>
    openProfileFor(ADMIN_TG, TARGET_ID, { bot: bot as never, prisma: fakePrisma(target, language) as never });

  await check('a public username gives the t.me link and sends nothing; getChat asked for the user\'s own Telegram id', async () => {
    const { bot, calls } = fakeBot({ chat: { id: TARGET_TG, username: USERNAME } });
    const result = await run(bot, person);
    assert(show(result) === show({ kind: 'link', url: `https://t.me/${USERNAME}` }), `result ${show(result)}`);
    assert(show(calls.map((c) => c.method)) === show(['getChat']) && calls[0].params.chat_id === TARGET_TG, `calls ${show(calls)}`);
  });

  await check('a username that is not a username is no link: the mention is sent instead', async () => {
    const { bot, calls } = fakeBot({ chat: { id: TARGET_TG, username: 'x"><script>' } });
    const result = await run(bot, person);
    assert(show(result) === show({ kind: 'sent' }) && calls.some((c) => c.method === 'sendMessage'), `result ${show(result)} calls ${show(calls)}`);
  });

  await check('no username: one message to the admin\'s chat, HTML, the mention with the name escaped, the admin\'s language', async () => {
    const { bot, calls } = fakeBot({ chat: { id: TARGET_TG } });
    const result = await run(bot, person);
    assert(show(result) === show({ kind: 'sent' }), `result ${show(result)}`);
    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert(sends.length === 1, `${sends.length} sends`);
    const p = sends[0].params;
    assert(p.chat_id === ADMIN_TG && p.parse_mode === 'HTML', `chat ${String(p.chat_id)} mode ${String(p.parse_mode)}`);
    const want = String(enMessages.bot.adminProfileLink).replace('{name}', `<a href="tg://user?id=${TARGET_TG}">&lt;b&gt;&amp;&quot;</a>`);
    assert(p.text === want, `text ${show(p.text)} want ${show(want)}`);
    assert(!String(p.text).includes(NAME), 'the raw name is in the message');
  });

  await check('the message is in the admin\'s language (he)', async () => {
    const { bot, calls } = fakeBot({});
    await run(bot, person, 'he');
    const text = String(calls.find((c) => c.method === 'sendMessage')?.params.text);
    assert(text.startsWith(String(heMessages.bot.adminProfileLink).split('{name}')[0]), `text ${show(text)}`);
  });

  await check('a user with no name is mentioned by the id', async () => {
    const { bot, calls } = fakeBot({});
    await run(bot, { telegramId: BigInt(TARGET_TG), name: '' });
    const text = String(calls.find((c) => c.method === 'sendMessage')?.params.text);
    assert(text.includes(`<a href="tg://user?id=${TARGET_TG}">${TARGET_TG}</a>`), `text ${show(text)}`);
  });

  await check('a getChat that Telegram refused also sends the mention', async () => {
    const { bot, calls } = fakeBot({ getChatError: tgRefused(400, 'Bad Request: chat not found') });
    const result = await run(bot, person);
    assert(show(result) === show({ kind: 'sent' }), `result ${show(result)}`);
    assert(show(calls.map((c) => c.method)) === show(['getChat', 'sendMessage']), `calls ${show(calls.map((c) => c.method))}`);
  });

  await check('no Telegram id, or no such user: notFound with zero bot calls', async () => {
    for (const target of [{ telegramId: null, name: NAME }, null]) {
      const { bot, calls } = fakeBot({});
      const result = await run(bot, target);
      assert(show(result) === show({ kind: 'notFound' }) && calls.length === 0, `result ${show(result)} calls ${show(calls)}`);
    }
  });

  await check('a send that throws gives failed (and so does a getChat that gave no answer followed by a failed send)', async () => {
    const one = fakeBot({ chat: { id: TARGET_TG }, sendError: tgNoAnswer() });
    assert(show(await run(one.bot, person)) === show({ kind: 'failed' }), 'send failure');
    const two = fakeBot({ getChatError: tgNoAnswer('getChat'), sendError: tgRefused(403, 'Forbidden: bot was blocked by the user') });
    assert(show(await run(two.bot, person)) === show({ kind: 'failed' }), 'getChat then send failure');
  });

  await check('the route\'s answers: link 200 with its url, sent 200, notFound 404, failed 502, all with success true only on 200', () => {
    assert(show(openProfileAnswer({ kind: 'link', url: 'https://t.me/a' })) === show({ status: 200, body: { success: true, kind: 'link', url: 'https://t.me/a' } }), 'link');
    assert(show(openProfileAnswer({ kind: 'sent' })) === show({ status: 200, body: { success: true, kind: 'sent' } }), 'sent');
    assert(openProfileAnswer({ kind: 'notFound' }).status === 404 && openProfileAnswer({ kind: 'failed' }).status === 502, 'errors');
  });

  await check('the route asks verifyAdminAccess before openProfileFor, reads initData through requestInitData, and answers 400 for a bad body', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/api/admin/open-profile/route.ts'), 'utf8');
    const auth = source.indexOf('verifyAdminAccess(');
    const open = source.indexOf('openProfileFor(');
    assert(auth > 0 && open > auth, `verifyAdminAccess at ${auth}, openProfileFor at ${open}`);
    assert(source.includes('requestInitData(') && /status:\s*400/.test(source) && /\b403\b/.test(source) && /\b401\b/.test(source), 'initData, 400, 401 or 403 missing');
  });

  await check('the service sends only through getBot() and reads Telegram failures only through telegramErrorInfo', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/services/admin-open-profile.ts'), 'utf8');
    assert(source.includes('getBot()') && source.includes('telegramErrorInfo('), 'getBot or telegramErrorInfo missing');
    assert(!/\.response\b|instanceof\s+(?!Error\b)/.test(source), 'a Telegram error is read by its class or .response');
  });

  await check('openTelegramLink opens https://t.me/... only: Telegram\'s client (6.1+) or a new tab; tg://user?id=1 and https://example.com are refused', async () => {
    const opened: string[] = [];
    const tgCalls: string[] = [];
    const g = globalThis as Record<string, unknown>;
    g.window = {
      open: (...a: unknown[]) => void opened.push(a.join(' ')),
      Telegram: { WebApp: { initData: 'x', version: '8.0', isVersionAtLeast: () => true, openTelegramLink: (u: string) => void tgCalls.push(u) } },
    };
    try {
      const { openTelegramLink } = await import('../src/lib/telegram-ui');
      assert(openTelegramLink('https://t.me/alice_fake') === true && show(tgCalls) === show(['https://t.me/alice_fake']) && opened.length === 0, `in Telegram: ${show(tgCalls)} ${show(opened)}`);
      for (const bad of ['tg://user?id=1', 'https://example.com', 'https://t.me.evil.example/x', 'http://t.me/x', 'javascript:alert(1)', '/en/settings']) {
        assert(openTelegramLink(bad) === false, `${bad} was accepted`);
      }
      assert(tgCalls.length === 1 && opened.length === 0, `a bad link opened: ${show(tgCalls)} ${show(opened)}`);
      (g.window as { Telegram: unknown }).Telegram = { WebApp: { initData: '', version: '6.0', isVersionAtLeast: () => false } };
      assert(openTelegramLink('https://t.me/alice_fake') === true && opened.slice(0).length === 1 && opened[0].startsWith('https://t.me/alice_fake _blank'), `browser: ${show(opened)}`);
    } finally {
      delete g.window;
    }
  });

  await check('no console line written during the run holds the name, the username, the message text or the admin\'s or the user\'s chat id', () => {
    const joined = written.join('\n');
    for (const secret of [NAME, '&lt;b&gt;', USERNAME, String(enMessages.bot.adminProfileLink).split('{name}')[0].trim(), String(TARGET_TG), String(ADMIN_TG)]) {
      assert(!joined.includes(secret), `the log holds ${show(secret)}: ${joined.slice(0, 400)}`);
    }
    assert(written.some((l) => l.startsWith('[admin-open-profile] admin 1 user 7: ')), `no outcome line: ${show(written.slice(0, 5))}`);
  });

  let failed = 0;
  for (const r of results) {
    out(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  out(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
