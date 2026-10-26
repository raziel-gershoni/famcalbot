// Smoke test for the "remind us both" migration (prisma/migrations/20261026000000_remind_us_both):
// the SQL adds NativeEvent.forBoth and the NativeReminderPing table with its keys, copies every
// state row's ping data into a ping row for the person it pinged, and drops nothing (the previous
// build still serves while it runs), and the Prisma schema agrees with it: the state model has lost
// its ping columns, the ping model has them. Text checks only: no database is reached.
//
// Run: npx tsx scripts/smoke-remind-us-both-migration.ts

import fs from 'fs';
import path from 'path';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const ROOT = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20261026000000_remind_us_both/migration.sql'), 'utf8');
const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
/** The statements, without the comments. */
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

/** The body of `model <name> { ... }` in schema.prisma. */
function modelBody(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match) throw new Error(`no model ${name}`);
  return match[1];
}
/** The scalar column names of a model body (relations and attributes left out). */
function columns(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z]\w*\s+(String|Int|BigInt|Boolean|DateTime)\b/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

const PING_COLUMNS = ['snoozedUntil', 'lastPingedAt', 'pingAttempts', 'pingChatId', 'pingMessageId'];

check('the migration adds forBoth, idempotently, as a boolean defaulting to false', () => {
  assert(/ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "forBoth" BOOLEAN NOT NULL DEFAULT false;/.test(code), 'the forBoth column');
});

check('the migration creates NativeReminderPing with the spec\'s columns, its unique (stateId, userId) key and its snoozedUntil index, all IF NOT EXISTS', () => {
  assert(/CREATE TABLE IF NOT EXISTS "NativeReminderPing"/.test(code), 'the table');
  for (const column of ['id', 'stateId', 'userId', ...PING_COLUMNS, 'createdAt', 'updatedAt']) {
    assert(new RegExp(`"${column}" `).test(code.slice(code.indexOf('CREATE TABLE IF NOT EXISTS "NativeReminderPing"'), code.indexOf(');', code.indexOf('CREATE TABLE IF NOT EXISTS "NativeReminderPing"')))), `column ${column}`);
  }
  assert(/CREATE UNIQUE INDEX IF NOT EXISTS "NativeReminderPing_stateId_userId_key" ON "NativeReminderPing"\("stateId", "userId"\);/.test(code), 'the unique key');
  assert(/CREATE INDEX IF NOT EXISTS "NativeReminderPing_snoozedUntil_idx" ON "NativeReminderPing"\("snoozedUntil"\);/.test(code), 'the snoozedUntil index');
});

check('both foreign keys cascade (a state row or a user going takes its pings), guarded so a re-run is a no-op', () => {
  for (const [column, target] of [['stateId', 'NativeReminderState'], ['userId', 'User']]) {
    const key = new RegExp(`ADD CONSTRAINT "NativeReminderPing_${column}_fkey"\\s+FOREIGN KEY \\("${column}"\\) REFERENCES "${target}"\\("id"\\) ON DELETE CASCADE ON UPDATE CASCADE;\\s+EXCEPTION WHEN duplicate_object THEN null;`);
    assert(key.test(code), `the ${column} key`);
  }
});

check('the copy: every state row with any ping data becomes a ping row for COALESCE(forUserId, creatorUserId), with a generated id, once', () => {
  const copy = code.slice(code.indexOf('INSERT INTO "NativeReminderPing"'));
  assert(copy.startsWith('INSERT INTO "NativeReminderPing"'), 'the copy statement');
  assert(/gen_random_uuid\(\)::text/.test(copy), 'ids generated in SQL');
  assert(/COALESCE\(e\."forUserId", e\."creatorUserId"\)/.test(copy), 'the recipient');
  assert(/FROM "NativeReminderState" s\s+JOIN "NativeEvent" e ON e\."id" = s\."seriesEventId"/.test(copy), 'joined on the series');
  for (const column of PING_COLUMNS) assert(new RegExp(`s\\."${column}"`).test(copy), `copies ${column}`);
  for (const test of ['s."snoozedUntil" IS NOT NULL', 's."lastPingedAt" IS NOT NULL', 's."pingAttempts" > 0', 's."pingChatId" IS NOT NULL', 's."pingMessageId" IS NOT NULL']) {
    assert(copy.includes(test), `only rows with data: ${test}`);
  }
  assert(/ON CONFLICT \("stateId", "userId"\) DO NOTHING;/.test(copy), 'a re-run copies nothing twice');
});

check('nothing is dropped, and the header says why the old columns stay and that a later push drops them', () => {
  assert(!/\bDROP\b/i.test(code), 'a DROP statement');
  assert(!/DELETE FROM|TRUNCATE/i.test(code), 'a delete');
  const header = sql.split('\n').filter((line) => line.trim().startsWith('--')).join('\n');
  assert(/NOT dropped/.test(header) && /previous\s+code still serves/.test(header) && /later push drops/.test(header), 'the header');
  assert(/claim\.ts/.test(header), 'it names the claim\'s fallback');
});

check('the schema agrees: the state model has no ping columns left, the ping model has all of them, and NativeEvent has forBoth', () => {
  const state = columns(modelBody('NativeReminderState'));
  for (const column of PING_COLUMNS) assert(!state.includes(column), `NativeReminderState still has ${column}`);
  assert(state.includes('doneAt') && state.includes('doneByUserId'), 'Done stays on the state');
  assert(!/@@index\(\[snoozedUntil\]\)/.test(modelBody('NativeReminderState')), 'the state\'s snoozedUntil index is gone from the schema');
  const ping = columns(modelBody('NativeReminderPing'));
  for (const column of ['id', 'stateId', 'userId', ...PING_COLUMNS, 'createdAt', 'updatedAt']) assert(ping.includes(column), `NativeReminderPing lacks ${column}`);
  assert(/@@unique\(\[stateId, userId\]\)/.test(modelBody('NativeReminderPing')) && /@@index\(\[snoozedUntil\]\)/.test(modelBody('NativeReminderPing')), 'its unique key and index');
  assert(/forBoth\s+Boolean\s+@default\(false\)/.test(modelBody('NativeEvent')), 'NativeEvent.forBoth');
  // The SQL table has exactly the model's columns.
  const created = code.slice(code.indexOf('CREATE TABLE IF NOT EXISTS "NativeReminderPing"'), code.indexOf('CONSTRAINT "NativeReminderPing_pkey"'));
  const sqlColumns = [...created.matchAll(/^\s+"(\w+)" /gm)].map((m) => m[1]).sort();
  assert(JSON.stringify(sqlColumns) === JSON.stringify([...ping].sort()), `SQL columns ${sqlColumns} vs schema ${[...ping].sort()}`);
});

check('the migration is the newest, so it runs after the ones whose tables it reads', () => {
  const names = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
  assert(names[names.length - 1] === '20261026000000_remind_us_both', `newest is ${names[names.length - 1]}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
