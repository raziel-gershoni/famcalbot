// Smoke test: no cache copy outlives the Privacy Policy's "up to 30 days" (the final review's M-2). The Policy says the
// longest short-lived copies are kept 30 days, and cache copies stay "up to 30 days" (after a deletion too); only the
// settings copy of the reminder run lives as long as the account, and the Policy names it.
//
//  - C1 every expiry the code gives a Redis key (`{ ex: … }` on a set, `expire(key, …)`) is 30 days or less: a number,
//    a product of numbers, or a constant (of any file in src/) that is one. A TTL the check can't read fails it, so a
//    new one is added in a form it can.
//  - C2 the two that were longer are capped and still guard what they guard: the subscription reminders' marks
//    outlive the windows that read them (the 3-day reminder looks 4 days ahead), and a Google setup track's attempt marks
//    outlive its window; the track's start is account data now (User.googleNudgeStartedAt), not a cache key.
//
// Nothing runs: the sources and the exported constants only. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-cache-retention.ts

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const LIMIT_S = 30 * 24 * 60 * 60;

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

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** A product of numbers ("30 * 24 * 60 * 60", "86_400"), or null. */
function product(expr: string): number | null {
  const clean = expr.replace(/_/g, '').trim();
  if (!/^\d+(?:\s*\*\s*\d+)*$/.test(clean)) return null;
  return clean.split('*').reduce((n, part) => n * Number(part.trim()), 1);
}

async function main() {
  const sources = files(SRC).map((file) => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));
  // Every `const NAME = <a product of numbers>` in src/, by name (a name used twice must mean the same everywhere)
  const constants = new Map<string, number>();
  for (const { text } of sources) {
    for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*([\d_\s*]+?)\s*;/g)) {
      const value = product(m[2]);
      if (value !== null) constants.set(m[1], Math.max(value, constants.get(m[1]) ?? 0));
    }
  }
  const resolve = (expr: string): number | null => {
    const literal = product(expr);
    if (literal !== null) return literal;
    const name = expr.trim().replace(/^\w+\./, '');
    return constants.get(name) ?? null;
  };

  await check('C1 every Redis expiry in src/ is 30 days or less (a number, a product of numbers, or a constant that is one)', () => {
    const found: { at: string; expr: string; seconds: number | null }[] = [];
    for (const { file, text } of sources) {
      const lineOf = (index: number) => text.slice(0, index).split('\n').length;
      for (const m of text.matchAll(/\bex:\s*([^,}\n]+?)\s*(?:[,}])/g)) found.push({ at: `${file}:${lineOf(m.index ?? 0)}`, expr: m[1], seconds: resolve(m[1]) });
      for (const m of text.matchAll(/\.expire\(\s*[^,]+,\s*([^,)]+?)\s*[,)]/g)) found.push({ at: `${file}:${lineOf(m.index ?? 0)}`, expr: m[1], seconds: resolve(m[1]) });
    }
    // The setup reminders' sender takes its expiry as a parameter: each caller passes a constant, read like the others
    const handlers = sources.find((s) => s.file === 'src/cron/handlers.ts')?.text ?? '';
    const passed = [...handlers.matchAll(/sendSetupReminder\([^;]*?,\s*(tracks\.[A-Z_]+)\)/g)].map((m) => m[1]);
    assert(passed.length >= 3, `the setup reminders' callers: ${show(passed)}`);
    for (const expr of passed) found.push({ at: 'src/cron/handlers.ts (sendSetupReminder)', expr, seconds: resolve(expr) });
    const unread = found.filter((f) => f.seconds === null && f.expr !== 'ttlSeconds');
    assert(unread.length === 0, `expiries the check can't read (write them as a number or a constant): ${show(unread)}`);
    const long = found.filter((f) => f.seconds !== null && f.seconds > LIMIT_S);
    assert(long.length === 0, `longer than 30 days: ${show(long)}`);
    assert(found.length >= 30, `only ${found.length} expiries found: the scan no longer reads the code`);
  });

  await check('C2 the subscription reminders and the setup tracks: their marks last 30 days at most and still outlive what they guard; the Google track\'s start is on the user\'s row', async () => {
    const reminders = fs.readFileSync(path.join(SRC, 'services/subscription-reminders.ts'), 'utf8');
    const { SETUP_ATTEMPT_TTL_SECONDS, GOOGLE_TRACK_WINDOW_DAYS, SETUP_SCHEDULES } = await import('../src/services/setup-tracks');
    const ttl = constants.get('SUBSCRIPTION_REMINDER_TTL_SECONDS');
    assert(ttl !== undefined && ttl <= LIMIT_S, `the subscription reminders keep their marks ${ttl} s`);
    // The widest window that reads a mark: sendExpiringReminders(3) looks daysLeft + 1 days ahead
    const widest = Math.max(...[...reminders.matchAll(/sendExpiringReminders\((\d+)\)/g)].map((m) => Number(m[1]) + 1));
    assert(Number.isFinite(widest) && widest * 86400 < ttl, `a reminder window of ${widest} days against marks of ${ttl} s`);
    assert(SETUP_ATTEMPT_TTL_SECONDS <= LIMIT_S && GOOGLE_TRACK_WINDOW_DAYS * 86400 <= SETUP_ATTEMPT_TTL_SECONDS, `the setup marks (${SETUP_ATTEMPT_TTL_SECONDS} s) against the window (${GOOGLE_TRACK_WINDOW_DAYS} days)`);
    const lastAttempt = Math.max(...Object.values(SETUP_SCHEDULES).flat());
    assert(lastAttempt < GOOGLE_TRACK_WINDOW_DAYS, `a track's last attempt (day ${lastAttempt}) falls outside its window`);
    const tracks = fs.readFileSync(path.join(SRC, 'services/setup-tracks.ts'), 'utf8').replace(/^\s*(?:\/\/|\*).*$/gm, '');
    assert(!/redis\.set\(\s*REDIS_KEYS\.setupTrackStart/.test(tracks) && /googleNudgeStartedAt/.test(tracks), 'the Google track\'s start is written to Redis again');
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
