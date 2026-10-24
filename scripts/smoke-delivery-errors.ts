// Smoke test for src/lib/delivery-errors.ts and markUnreachableAfterWhatsAppFailure
// (src/lib/user-reachability.ts): which delivery failures mean "this recipient can never
// receive", for Telegram and for the WhatsApp Cloud API.
//
// WhatsApp codes are Meta's (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/).
// Only 131026 counts. 131047 (24-hour window), the rate limits (131056, 130429), server errors
// and everything unclear must stay "other". A user with a Telegram chat is not flagged for a
// WhatsApp failure. The WhatsApp webhook clears the flag when the user writes again.
//
// Faked: Prisma, analytics, Sentry. No network, no DB.
//
// Run: npx tsx scripts/smoke-delivery-errors.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) }); }
}

const SRC = path.resolve(__dirname, '../src');
const updates: unknown[] = [];
const stubs: Record<string, object> = {
  [`${SRC}/utils/prisma.ts`]: { prisma: { user: { updateMany: async (a: unknown) => { updates.push(a); return { count: 1 }; } } } },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {} },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {} },
};
const M = Module as unknown as { _load: (...a: unknown[]) => unknown; _resolveFilename: (...a: unknown[]) => string };
const realLoad = M._load;
M._load = function (request: unknown, parent: unknown, isMain: unknown) {
  let resolved = String(request);
  try { resolved = M._resolveFilename(request, parent, isMain); } catch { /* not resolvable here: load it as it is */ }
  if (resolved in stubs) return stubs[resolved];
  return realLoad.call(this, request, parent, isMain);
};

/** What the adapter throws for a failed send: the API body as JSON in the message. */
const apiError = (code: number) =>
  new Error(`WhatsApp API error: ${JSON.stringify({ error: { message: 'x', type: 'OAuthException', code, error_data: { messaging_product: 'whatsapp', details: 'x' }, fbtrace_id: 'abc' } })}`);

async function main() {
  const log = console.log; const warn = console.warn;
  console.warn = () => {};
  console.log = () => {};
  const { isUnreachableError, classifyDeliveryFailure } = await import('../src/lib/delivery-errors');
  const { markUnreachableAfterWhatsAppFailure, markUnreachableAfterSendFailure } = await import('../src/lib/user-reachability');

  await check('Telegram: a blocked bot is unreachable, a bare 403 is not', () => {
    const blocked = Object.assign(new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user'), { response: { body: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } } });
    assert(isUnreachableError(blocked), 'blocked not classified');
    assert(!isUnreachableError(new Error('ETELEGRAM: 403 Forbidden: something new')), 'bare 403 classified');
  });

  await check('WhatsApp 131026 (undeliverable: not a WhatsApp number, ToS, old client) is unreachable, from a send error and from a status', () => {
    assert(classifyDeliveryFailure(apiError(131026)) === 'unreachable', 'send error not classified');
    assert(isUnreachableError(Object.assign(new Error('x'), { whatsappError: { code: 131026 } })), 'status error not classified');
  });

  await check('WhatsApp codes that are not permanent recipient-side failures stay "other"', () => {
    const others = [131047, 131056, 130429, 131000, 131049, 131050, 131403, 131031, 131045, 133010, 368, 80007, 131021, 131030, 100, 190, 1, 2, 4, 17, 32];
    for (const code of others) assert(!isUnreachableError(apiError(code)), `${code} classified as unreachable`);
    assert(!isUnreachableError(Object.assign(new Error('x'), { whatsappError: { code: 131047 } })), '131047 status classified');
    assert(!isUnreachableError(new Error('WhatsApp API error: not json at all')), 'unparseable classified');
    assert(!isUnreachableError(new Error('WhatsApp media upload error: {"error":{"code":131026}}')), 'a non-send error classified');
    assert(!isUnreachableError(new Error('fetch failed')), 'network error classified');
  });

  await check('a WhatsApp-only user is flagged for 131026; 131047 flags nobody', async () => {
    updates.length = 0;
    assert(await markUnreachableAfterWhatsAppFailure({ id: 5, telegramId: null }, apiError(131026)) === true, 'not flagged');
    assert(updates.length === 1, `updates ${JSON.stringify(updates)}`);
    assert(await markUnreachableAfterWhatsAppFailure({ id: 5, telegramId: null }, apiError(131047)) === false, '131047 flagged');
    assert(updates.length === 1, 'an update ran for 131047');
  });

  await check('a user who also has Telegram is not flagged for a WhatsApp failure', async () => {
    updates.length = 0;
    assert(await markUnreachableAfterWhatsAppFailure({ id: 6, telegramId: 99 }, apiError(131026)) === false, 'flagged');
    assert(updates.length === 0, 'an update ran');
  });

  await check('markUnreachableAfterSendFailure: a Telegram 403 flags the user (Telegram id or not); a WhatsApp 131026 flags only a WhatsApp-only user, a bigint Telegram id counts', async () => {
    const blocked = Object.assign(new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user'), { response: { body: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } } });
    updates.length = 0;
    assert(await markUnreachableAfterSendFailure({ id: 7, telegramId: 99 }, blocked) === true && updates.length === 1, 'telegram 403 not flagged');
    updates.length = 0;
    assert(await markUnreachableAfterSendFailure({ id: 7, telegramId: 99 }, apiError(131026)) === false && updates.length === 0, "'all' user flagged for 131026");
    assert(await markUnreachableAfterSendFailure({ id: 7, telegramId: BigInt(99) }, apiError(131026)) === false && (updates.length as number) === 0, 'bigint id user flagged');
    assert(await markUnreachableAfterSendFailure({ id: 7, telegramId: null }, apiError(131026)) === true && (updates.length as number) === 1, 'WhatsApp-only not flagged');
    updates.length = 0;
    assert(await markUnreachableAfterSendFailure({ id: 7, telegramId: null }, apiError(131047)) === false && updates.length === 0, '131047 flagged');
  });

  await check('no send path flags a user by calling markUserUnreachable itself', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && full !== path.join(SRC, 'lib/user-reachability.ts') && /markUserUnreachable/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(SRC, full));
      }
    };
    walk(SRC);
    assert(offenders.length === 0, `direct markUserUnreachable in ${offenders.join(', ')}`);
  });

  await check('the WhatsApp webhook clears the flag when the user writes (text path and voice path), and the summary path flags', () => {
    const webhook = fs.readFileSync(path.join(SRC, 'services/webhook-handlers.ts'), 'utf8');
    const wa = webhook.slice(webhook.indexOf('export async function handleWhatsAppWebhook'));
    assert((wa.match(/clearUserUnreachable\(user\.id\)/g) ?? []).length >= 2, 'handleWhatsAppWebhook does not clear on both the text and the voice path');
    assert(wa.includes('markUnreachableAfterWhatsAppFailure'), 'the failed-status callback does not flag');
    const summary = fs.readFileSync(path.join(SRC, 'services/telegram/summary.ts'), 'utf8');
    assert(summary.includes('markUnreachableAfterSendFailure(user, e)'), 'the WhatsApp summary delivery does not flag');
  });

  console.log = log; console.warn = warn;
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main();
