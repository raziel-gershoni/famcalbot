// Smoke test for the "remind us both" deploy-window compatibility (src/services/native-reminders/
// deploy-compat.ts, this release only, removed with the step-2 SQL): the catch-up that copies what the
// previous build wrote to the state rows' old ping columns into the ping rows, how it is scheduled
// (at boot and +5, +15, +30 minutes, never blocking), how it fails (logged, to Sentry, never thrown),
// and the write of the old lastPingedAt after a sent single reminder. The SQL's behaviour against a
// real Postgres is checked by the reviewer's PGlite probe; here the statements are checked by shape.
// Prisma and Sentry are faked; timers are captured, not run. No network, no DB.
//
// Run: npx tsx scripts/smoke-native-reminder-deploy-compat.ts

import path from 'path';

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

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

type Row = Record<string, unknown>;
const statements: { sql: string; values: unknown[] }[] = [];
let rowsWritten = 3;
let failWith: Error | null = null;
const captured: { context: string; extra?: Row; severity?: string }[] = [];
const logs: string[] = [];

const fakePrisma = {
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (failWith) throw failWith;
    statements.push({ sql: strings.join('$'), values });
    return rowsWritten;
  },
};

async function main() {
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('lib/error-capture.ts', {
    captureError: (_e: unknown, context: string, extra?: Row, severity?: string) => captured.push({ context, extra, severity }),
    captureWarning: () => {},
    captureInfo: () => {},
  });
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };

  const { catchUpOldPingWrites, runCatchUp, scheduleCatchUps, recordOldLastPing } = await import('../src/services/native-reminders/deploy-compat');

  await check('the catch-up is one statement: the old columns into the old recipient\'s ping row, where newer, and only for state rows written after the ping row', async () => {
    statements.length = 0;
    assert((await catchUpOldPingWrites()) === 3, 'it returns how many ping rows it wrote');
    assert(statements.length === 1, `${statements.length} statements`);
    const sql = statements[0].sql;
    assert(/INSERT INTO "NativeReminderPing" AS p/.test(sql) && /FROM "NativeReminderState" s\s+JOIN "NativeEvent" e ON e\."id" = s\."seriesEventId"/.test(sql), 'inserts ping rows from state rows');
    assert(/COALESCE\(e\."forUserId", e\."creatorUserId"\)/.test(sql), 'for the person the old build pinged, as the migration');
    assert(/ON CONFLICT \("stateId", "userId"\) DO UPDATE/.test(sql), 'updates the ping row when there is one');
    assert(/WHERE EXCLUDED\."updatedAt" > p\."updatedAt"/.test(sql), 'only when the state row was written after the ping row (the old build wrote it)');
    for (const column of ['snoozedUntil', 'lastPingedAt', 'pingAttempts', 'pingChatId', 'pingMessageId']) assert(sql.includes(`"${column}" =`), `sets ${column}`);
    assert(/EXCLUDED\."snoozedUntil" > p\."snoozedUntil"/.test(sql) && /EXCLUDED\."lastPingedAt" > COALESCE\(p\."lastPingedAt", 'epoch'::timestamp\)/.test(sql), 'a newer snooze and a newer ping only');
    assert(!/\bDROP\b|\bDELETE\b/i.test(sql), 'writes only');
  });

  await check('runCatchUp logs how many rows it brought up to date and never throws; a failure goes to Sentry with its label', async () => {
    logs.length = 0;
    captured.length = 0;
    rowsWritten = 2;
    await runCatchUp('boot');
    assert(logs.some((l) => l.includes('Deploy catch-up (boot)') && l.includes('2 ping row(s)')), `log: ${logs.join(' | ')}`);
    assert(captured.length === 0, 'nothing reported');
    failWith = new Error('connection reset');
    await runCatchUp('+5 min');
    failWith = null;
    assert(captured.length === 1 && captured[0].context === 'native-reminders-deploy-catchup' && captured[0].extra?.label === '+5 min', JSON.stringify(captured));
    assert(logs.some((l) => l.includes('Deploy catch-up (+5 min) failed')), 'logged');
  });

  await check('scheduleCatchUps runs now and again at +5, +15 and +30 minutes without holding the process open', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timers: { ms: number; fn: () => void; unrefd: boolean }[] = [];
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const t = { ms, fn, unrefd: false };
      timers.push(t);
      return { unref: () => { t.unrefd = true; } };
    }) as unknown as typeof setTimeout;
    try {
      statements.length = 0;
      scheduleCatchUps();
      await new Promise((resolve) => realSetTimeout(resolve, 10));
      assert(statements.length === 1, `the boot run: ${statements.length}`);
      assert(JSON.stringify(timers.map((t) => t.ms)) === JSON.stringify([5 * 60_000, 15 * 60_000, 30 * 60_000]), `timers ${timers.map((t) => t.ms)}`);
      assert(timers.every((t) => t.unrefd), 'unref\'d');
      for (const t of timers) t.fn();
      await new Promise((resolve) => realSetTimeout(resolve, 10));
      assert(statements.length === 4, `three more runs: ${statements.length}`);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  await check('the scheduler starts it at boot, apart from the pass, and the pass keeps no catch-up of its own', async () => {
    const { readFileSync } = await import('fs');
    const scheduler = readFileSync(path.resolve(__dirname, '../src/cron/scheduler.ts'), 'utf8');
    assert(/import\('\.\.\/services\/native-reminders\/deploy-compat'\)\s*\.then\(\(\{ scheduleCatchUps \}\) => scheduleCatchUps\(\)\)/.test(scheduler), 'scheduler start');
    const pass = readFileSync(path.resolve(__dirname, '../src/services/native-reminders/pass.ts'), 'utf8');
    assert(!pass.includes('catchUp'), 'the pass');
  });

  await check('recordOldLastPing sets the state row\'s own lastPingedAt only forward, and a failure is logged and reported, never thrown', async () => {
    statements.length = 0;
    captured.length = 0;
    await recordOldLastPing('state-1', new Date('2026-10-26T10:00:00Z'), 7);
    const { sql, values } = statements[0];
    assert(/UPDATE "NativeReminderState"\s+SET "lastPingedAt" = /.test(sql) && /"lastPingedAt" IS NULL OR "lastPingedAt" </.test(sql), sql);
    assert(values[1] === 'state-1' && values[0] === '2026-10-26T10:00:00.000Z', JSON.stringify(values));
    assert(!/updatedAt/.test(sql), 'it leaves updatedAt alone, so the catch-up does not take it for an old-build write');
    failWith = new Error('boom');
    await recordOldLastPing('state-1', new Date(), 7);
    failWith = null;
    assert(captured.length === 1 && captured[0].context === 'native-reminders-old-last-ping' && captured[0].extra?.state_id === 'state-1' && captured[0].extra?.user_id === 7, JSON.stringify(captured));
  });

  console.log = realLog;
  console.error = realError;
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
