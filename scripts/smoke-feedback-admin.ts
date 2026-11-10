// Smoke test for the admin's copy of a person's feedback (web sign-up plan, Task 12; spec 2026-11-03-web-sign-up §2.15):
// notifyAdminFeedback (src/utils/error-notifier.ts) names the sender by their FamCal id, and by their Telegram id too
// when they have one. An account made on famcal.bot has no Telegram, and its feedback reached the admin as "ID: N/A".
//
//  - A1 from an account with no Telegram: "FamCal id: 42", no Telegram line, no "N/A"; the name is escaped.
//  - A2 from a Telegram account: "FamCal id: 7" and "Telegram id: 1007"; a payment question's facts follow the sender.
//  - A3 both callers (the web app's /api/feedback and the bot's /feedback and /paysupport) hand it the person, not a
//    bare Telegram id.
//
// Real: error-notifier.ts and the escaping; the bot and Prisma are fakes that record. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   $RUN smoke-feedback-admin   ($RUN is the header's single-smoke runner)

import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
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
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

const sent: { chatId: number; text: string }[] = [];
const fakeBot = { sendMessage: async ({ chat_id: chatId, text }: { chat_id: number; text: string }) => { sent.push({ chatId, text }); return {}; } };
const fakePrisma = { user: { findMany: async () => [{ telegramId: BigInt(900) }] } };

async function main() {
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.join(ROOT, file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('src/utils/prisma.ts', { prisma: fakePrisma });
  stub('src/services/telegram/index.ts', { getBot: () => fakeBot });

  const { notifyAdminFeedback } = (await import(path.join(ROOT, 'src/utils/error-notifier.ts'))) as Row;

  await check('A1 feedback from an account with no Telegram names its FamCal id, has no Telegram line and no "N/A", and the name is escaped', async () => {
    sent.length = 0;
    await notifyAdminFeedback({ id: 42, name: 'Dana <web>', telegramId: null }, 'The week view is lovely', 'dashboard');
    assert(sent.length === 1 && sent[0].chatId === 900, `sent ${show(sent)}`);
    const text = sent[0].text;
    assert(text.includes('From: Dana &lt;web&gt;\n') && text.includes('\nFamCal id: 42\n'), text);
    assert(!text.includes('Telegram id') && !text.includes('N/A') && !/\nID: /.test(text), text);
    assert(text.includes('Source: dashboard') && text.endsWith('The week view is lovely'), text);
  });

  await check('A2 feedback from a Telegram account names the FamCal id and the Telegram id; a payment question\'s facts follow the sender', async () => {
    sent.length = 0;
    await notifyAdminFeedback({ id: 7, name: 'Noa', telegramId: 1007 }, 'Refund please', 'paysupport', { Plan: 'PRO' });
    const text = sent[0]?.text ?? '';
    assert(text.startsWith('💳 <b>Payment question</b>\nFrom: Noa\nFamCal id: 7\nTelegram id: 1007\nSource: paysupport\nPlan: PRO\n'), text);
  });

  await check('A3 both callers hand notifyAdminFeedback the person (their id, name and Telegram id), not a bare Telegram id', () => {
    const route = fs.readFileSync(path.join(ROOT, 'app/api/feedback/route.ts'), 'utf8');
    const bot = fs.readFileSync(path.join(ROOT, 'src/services/telegram/commands.ts'), 'utf8');
    assert(/notifyAdminFeedback\(user, trimmedText, 'dashboard'\)/.test(route), 'the web route still passes the name and the Telegram id');
    assert(/notifyAdminFeedback\(user, trimmedText, source,/.test(bot), 'the bot still passes the name and the Telegram id');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
