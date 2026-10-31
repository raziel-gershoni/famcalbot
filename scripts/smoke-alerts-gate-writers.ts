// Smoke test for the event alerts gate's writers and the pass gate it shares (spec
// docs/superpowers/specs/2026-10-31-event-alerts-gate-design.md).
//
// The 5-minute event alerts pass reads the FamCal store only while the gate is open
// (src/services/event-alerts-gate.ts), so a write that adds a FamCal alert, or moves one earlier,
// must open it, or that alert waits for the next whole UTC hour and is lost. What it pins:
//   - the audit: every file under src/ and app/ that writes NativeEvent, NativeEventInstance,
//     NativeCalendar or Pairing rows, or calls one of the event store's four writes, is listed in
//     OPENS (it opens the gate, or writes only through the store, whose writes open it) or in
//     NO_NEW_ALERT with the reason; a new writer fails here until it is classified. The copy-to-Google
//     worker writes only its own marks (GoogleSyncItem, GoogleSyncLink), so the scan does not find it;
//   - the other openers: the reminder cache's writes, a plan regained, the manual run;
//   - the pass gate (src/utils/pass-gate.ts) of all three gates: closed until the next work or the
//     first whole UTC hour after the pass, whichever is sooner; a write during a pass keeps that
//     pass from closing it; each gate's own state on globalThis; and for the alerts, a pass that
//     is no longer the latest cannot close it;
//   - the feature-access key's TTL: it ends at an hh:59 UTC between 23 and 24 hours ahead.
//
// No network, no database (nothing here reads Prisma). Epoch arithmetic only, so the process zone
// does not matter; run it under another one to see:
//   TZ=Asia/Kolkata npx tsx scripts/smoke-alerts-gate-writers.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createPassGate, nextTopOfHourUtc, PASS_GATE_CEILING_MS } from '../src/utils/pass-gate';
import * as alerts from '../src/services/event-alerts-gate';
import * as due from '../src/services/native-reminders/due-gate';
import * as sync from '../src/services/google-sync/gate';

const ROOT = path.resolve(__dirname, '..');

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

// ---- The audit of every FamCal writer ----

/** An exported function's text, from its line to the closing brace at the start of a line. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert(start >= 0, `no export async function ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

/** Every .ts/.tsx file under src/ and app/. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(path.relative(ROOT, full));
    }
  };
  for (const root of ['src', 'app']) walk(path.join(ROOT, root));
  return out.sort();
}

/** A write to the rows the FamCal alerts are read from (prisma.x or a transaction client's tx.x). */
const TABLE_WRITE = /\b(nativeEvent|nativeEventInstance|nativeCalendar|pairing)\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\(/;
/** A call of one of the event store's four writes, each of which opens the gate. */
const STORE_WRITE = /\b(createNativeEvent|createNativeSeries|updateNativeEvent|deleteNativeEvent)\(/;
const OPENS_CALL = /\bopenEventAlertsGate\(\)/;

/** The files that open the gate after their write, or that write only through the store's four writes. */
const OPENS: Record<string, string> = {
  'src/services/native-calendar/event-store.ts': 'the four writes every FamCal event write goes through (createNativeEvent, createNativeSeries, updateNativeEvent, deleteNativeEvent) open it when done, for events and reminders',
  'src/services/calendar-provider/native-provider.ts': 'the bot\'s creates, edits, moves and deletes, through the store\'s writes',
  'src/services/calendar-write/write.ts': 'the Mini App\'s writes, through the store\'s writes',
  'src/services/calendar-move/move.ts': 'a move between calendars is a create and a delete, through the store\'s writes',
  'app/api/native-calendars/[id]/route.ts': 'PATCH: a kids label adds pickups, and sharing shows the partner the calendar\'s events',
  'src/services/pairing-service.ts': 'acceptInvite: each partner now sees the other\'s shared calendars (and unlink, for uniformity)',
  'src/services/account-linking.ts': 'afterMerge: T takes W\'s calendars, events and pairing',
};

/** The files that write those rows but can add no alert and move none earlier, each with why. */
const NO_NEW_ALERT: Record<string, string> = {
  'app/api/native-calendars/route.ts': 'POST: a new calendar is empty',
  'src/services/native-calendar/onboarding.ts': 'the main calendar a user starts with is empty',
  'src/services/kid-name-callbacks.ts': 'a calendar\'s person name or rule (and a Google choice\'s rule): no alert reads them',
  'src/services/calendar-provider/primary.ts': 'the primary label only: no alert reads it',
  'src/lib/user-moderation.ts': 'removes a user and their data: fewer alerts, never a new one',
};

/** Files outside the audit's tables that open the gate, each for a write the pass reads elsewhere. */
const OTHER_OPENERS: Record<string, string> = {
  'src/services/reminder-cache.ts': 'updateUserInCache (a settings save, Google connect, calendar choices, a merge) and a sync that adds a user or changes their pairing, default lead or pickup switch',
  'src/services/subscription-service.ts': 'invalidateFeatureAccessCache and invalidateAllFeatureAccessCaches: a plan regained, an override, early adoption',
  'app/api/reminders/route.ts': 'the manual run reads FamCal',
  'src/services/event-alerts-gate.ts': 'the gate itself',
};

async function runAudit(): Promise<void> {
  const files = sourceFiles();
  const text = new Map(files.map(file => [file, readFileSync(path.join(ROOT, file), 'utf8')]));
  const writers = files.filter(file => TABLE_WRITE.test(text.get(file)!) || STORE_WRITE.test(text.get(file)!));

  await check('every file that writes FamCal events, calendars or pairings is classified: it opens the event alerts gate, or is listed with why it adds no alert; a new writer fails here until it is', () => {
    const known = new Set([...Object.keys(OPENS), ...Object.keys(NO_NEW_ALERT)]);
    const unclassified = writers.filter(file => !known.has(file));
    assert(unclassified.length === 0, `writes FamCal rows but nobody classified it (open the gate after the write, or list it in NO_NEW_ALERT with the reason): ${unclassified.join(', ')}`);
    const stale = [...known].filter(file => !writers.includes(file));
    assert(stale.length === 0, `listed but no longer writes FamCal rows: ${stale.join(', ')}`);
  });

  await check('a file listed as opening opens the gate itself, or writes those rows only through the store\'s four writes; one listed as adding no alert does not open it', () => {
    const silent = Object.keys(OPENS).filter(file => {
      const source = text.get(file)!;
      return !OPENS_CALL.test(source) && (TABLE_WRITE.test(source) || !STORE_WRITE.test(source));
    });
    assert(silent.length === 0, `listed as opening, but writes the rows without opening the gate: ${silent.join(', ')}`);
    const surprising = Object.keys(NO_NEW_ALERT).filter(file => OPENS_CALL.test(text.get(file)!));
    assert(surprising.length === 0, `listed as adding no alert, but opens the gate: ${surprising.join(', ')}`);
    const importsIt = (file: string) => /from '(\.\.?\/)+(services\/)?event-alerts-gate'|from '@\/src\/services\/event-alerts-gate'|import\('@\/src\/services\/event-alerts-gate'\)/.test(text.get(file)!);
    const unimported = Object.keys(OPENS).filter(file => OPENS_CALL.test(text.get(file)!) && !importsIt(file));
    assert(unimported.length === 0, `call openEventAlertsGate without importing the event alerts gate: ${unimported.join(', ')}`);
  });

  await check('each of the event store\'s four writes opens the gate when its write is done, also when it threw (opensEventAlerts, try/finally)', () => {
    const store = text.get('src/services/native-calendar/event-store.ts')!;
    for (const name of ['createNativeEvent', 'createNativeSeries', 'updateNativeEvent', 'deleteNativeEvent']) {
      const body = new RegExp(`export async function ${name}\\([^)]*\\): Promise<[^>]+>+ \\{\\n  return opensEventAlerts\\(\\w+\\([^)]*\\)\\);\\n\\}`);
      assert(body.test(store), `${name} does not go through opensEventAlerts`);
    }
    assert(/async function opensEventAlerts<T>\(write: Promise<T>\): Promise<T> \{\n  try \{\n    return await write;\n  \} finally \{\n    openEventAlertsGate\(\);\n  \}\n\}/.test(store), 'opensEventAlerts does not open the gate in a finally');
  });

  await check('the openers outside those tables: the reminder cache\'s writes, the feature-access invalidations and the manual run', () => {
    const missing = Object.keys(OTHER_OPENERS).filter(file => !text.has(file) || !/openEventAlertsGate\(|gate\.open\(\)/.test(text.get(file)!));
    assert(missing.length === 0, `do not open the gate: ${missing.join(', ')}`);
    const cache = text.get('src/services/reminder-cache.ts')!;
    const subs = text.get('src/services/subscription-service.ts')!;
    for (const [source, name] of [[cache, 'updateUserInCache'], [subs, 'invalidateFeatureAccessCache'], [subs, 'invalidateAllFeatureAccessCaches']]) {
      const body = functionBody(source, name);
      assert(/\} finally \{\n(\s*\/\/[^\n]*\n)*\s*openEventAlertsGate\(\);\n\s*\}\n\}$/.test(body), `${name} does not open the gate in a finally`);
    }
    assert(/\n  if \(syncAddsAlerts\(previous, users\)\) openEventAlertsGate\(\);\n\}$/.test(functionBody(cache, 'syncReminderCache')), 'syncReminderCache does not open the gate when the sync adds alerts');
    const route = text.get('app/api/reminders/route.ts')!;
    assert(/openEventAlertsGate\(\);\n\s*return handleReminders\(windowMinutes\);/.test(route), 'the manual run does not open the gate before the pass');
  });

  await check('the 5-minute pass reads FamCal only through the gate, once per pass, and closes it only with its own token', () => {
    const handlers = text.get('src/cron/handlers.ts')!;
    assert(/const famcal = shouldReadFamcal\(tick\);\n  const famcalToken = famcal \? startFamcalPass\(\) : 0;/.test(handlers), 'handleReminders does not take the gate once per pass');
    assert(/processUserReminders\(user, windowMinutes, \{ famcal \}\)/.test(handlers), 'the users are not processed with the gate\'s answer');
    assert(/setNextFamcalAlert\([^;]*famcalToken\)/.test(handlers), 'the gate is not closed with the pass\'s token');
    assert(/'event-alerts-gate-held'/.test(handlers), 'a held gate is not captured');
  });
}

// ---- The pass gate ----

const iso = (s: string) => new Date(s);
const MIN = 60_000;

async function runGate(): Promise<void> {
  await check('nextTopOfHourUtc is the first whole UTC hour after the instant', () => {
    for (const [at, want] of [
      ['2026-10-31T12:00:00.000Z', '2026-10-31T13:00:00.000Z'],
      ['2026-10-31T12:37:12.345Z', '2026-10-31T13:00:00.000Z'],
      ['2026-10-31T12:59:59.999Z', '2026-10-31T13:00:00.000Z'],
      ['2026-10-31T23:30:00.000Z', '2026-11-01T00:00:00.000Z'],
    ]) {
      assert(nextTopOfHourUtc(iso(at)).toISOString() === want, `${at}: ${nextTopOfHourUtc(iso(at)).toISOString()}`);
    }
    assert(PASS_GATE_CEILING_MS === 60 * MIN && due.DUE_GATE_CEILING_MS === 60 * MIN && sync.SYNC_GATE_CEILING_MS === 60 * MIN, 'the ceilings are not an hour');
  });

  await check('the ceiling is the next :00: after a read at 12:37 the gate opens at 13:00 (not 13:37), sooner for an earlier next, never later', () => {
    const gate = createPassGate('__smokePassGate');
    gate.reset();
    const t = iso('2026-10-31T12:37:00.000Z');
    assert(gate.shouldRun(t), 'a fresh gate is closed');
    gate.setNext(null, t);
    assert(!gate.shouldRun(iso('2026-10-31T12:59:59.999Z')), 'open before 13:00');
    assert(gate.shouldRun(iso('2026-10-31T13:00:00.000Z')), 'closed at 13:00');
    gate.setNext(iso('2026-10-31T15:00:00.000Z'), t);
    assert(gate.shouldRun(iso('2026-10-31T13:00:00.000Z')), 'a later next slept past the :00');
    gate.setNext(iso('2026-10-31T12:50:00.000Z'), t);
    assert(!gate.shouldRun(iso('2026-10-31T12:49:59.999Z')) && gate.shouldRun(iso('2026-10-31T12:50:00.000Z')), 'not at the next');
  });

  await check('a write during a pass keeps that pass from closing the gate; the pass after it may', () => {
    const gate = createPassGate('__smokePassGate');
    gate.reset();
    const t = iso('2026-10-31T12:00:00.000Z');
    assert(gate.shouldRun(t), 'a fresh gate is closed');
    gate.open(); // the write lands while the pass reads
    gate.setNext(null, t);
    assert(gate.shouldRun(new Date(t.getTime() + 5 * MIN)), 'the pass closed the gate over a write it never read');
    gate.setNext(null, new Date(t.getTime() + 5 * MIN));
    assert(!gate.shouldRun(new Date(t.getTime() + 10 * MIN)), 'the pass that read the write did not close it');
  });

  await check('each gate keeps its own state on globalThis (shared by the bundles), and opening one opens no other', () => {
    due.__resetDueGateForTests();
    sync.__resetSyncGateForTests();
    alerts.__resetEventAlertsGateForTests();
    const t = iso('2026-10-31T12:00:00.000Z');
    const later = new Date(t.getTime() + 5 * MIN);
    due.setNextDue(null, t);
    sync.setNextSync(null, t);
    alerts.setNextFamcalAlert(null, t, alerts.startFamcalPass());
    const g = globalThis as unknown as Record<string, { nextAt: number; writtenSinceGate: boolean }>;
    for (const key of ['__nativeReminderDueGate', '__googleSyncGate', '__eventAlertsGate']) {
      assert(g[key] && g[key].nextAt === iso('2026-10-31T13:00:00.000Z').getTime(), `globalThis.${key} ${JSON.stringify(g[key])}`);
    }
    alerts.openEventAlertsGate();
    assert(alerts.shouldReadFamcal(later), 'openEventAlertsGate did not open the alerts gate');
    assert(!due.shouldRunPass(later) && !sync.shouldRunSync(later), 'opening the alerts gate opened another');
    g.__nativeReminderDueGate.nextAt = 0;
    assert(due.shouldRunPass(later), 'the due gate does not read the shared object');
    due.__resetDueGateForTests();
    sync.__resetSyncGateForTests();
  });

  await check('alerts: a fresh process reads at once; only the latest pass that read FamCal may close the gate (a stale token cannot)', () => {
    alerts.__resetEventAlertsGateForTests();
    const t = iso('2026-10-31T12:00:00.000Z');
    assert(alerts.shouldReadFamcal(t), 'a fresh gate is closed');
    const first = alerts.startFamcalPass();
    // A second pass (the manual run) reads FamCal while the first is still running, after a write.
    alerts.openEventAlertsGate();
    assert(alerts.shouldReadFamcal(t), 'the second pass did not read');
    const second = alerts.startFamcalPass();
    alerts.setNextFamcalAlert(null, t, first);
    const state = (globalThis as unknown as { __eventAlertsGate: { nextAt: number } }).__eventAlertsGate;
    assert(state.nextAt === 0, `a stale pass closed the gate until ${new Date(state.nextAt).toISOString()}`);
    alerts.setNextFamcalAlert(iso('2026-10-31T12:15:00.000Z'), t, second);
    assert(!alerts.shouldReadFamcal(iso('2026-10-31T12:14:59.999Z')) && alerts.shouldReadFamcal(iso('2026-10-31T12:15:00.000Z')), 'the latest pass did not close it until its next alert');
    alerts.__resetEventAlertsGateForTests();
    assert(alerts.shouldReadFamcal(t), 'a reset gate is closed');
  });
}

// ---- The feature-access key's TTL ----

async function runTtl(): Promise<void> {
  const { featureAccessTtlSeconds } = await import('../src/services/subscription-service');

  await check('the feature-access key ends at an hh:59 UTC between 23 and 24 hours ahead, so its recompute lands on a :00 pass', () => {
    for (const [at, ends] of [
      ['2026-10-31T12:37:20.000Z', '2026-11-01T11:59:00.000Z'],
      ['2026-10-31T12:00:30.000Z', '2026-11-01T11:59:00.000Z'],
      ['2026-10-31T12:58:59.000Z', '2026-11-01T11:59:00.000Z'],
      ['2026-10-31T12:59:00.000Z', '2026-11-01T12:59:00.000Z'],
      ['2026-10-31T12:59:40.000Z', '2026-11-01T12:59:00.000Z'],
      ['2026-10-31T23:10:00.000Z', '2026-11-01T22:59:00.000Z'],
    ]) {
      const now = iso(at).getTime();
      const got = new Date(now + featureAccessTtlSeconds(now) * 1000).toISOString();
      assert(got === ends, `written at ${at}: ends ${got}, not ${ends}`);
    }
    for (let i = 0; i < 2000; i++) {
      const now = iso('2026-10-31T00:00:00.000Z').getTime() + Math.floor(Math.random() * 7 * 24 * 60 * MIN);
      const ttl = featureAccessTtlSeconds(now);
      const ends = new Date(now + ttl * 1000);
      assert(ttl >= 23 * 3600 && ttl <= 24 * 3600, `${new Date(now).toISOString()}: ${ttl} s`);
      assert(ends.getUTCMinutes() === 59 && ends.getUTCSeconds() <= 1, `${new Date(now).toISOString()}: ends ${ends.toISOString()}`);
    }
  });

  await check('the feature-access answer is cached with that TTL, not a flat day', () => {
    const subs = readFileSync(path.join(ROOT, 'src/services/subscription-service.ts'), 'utf8');
    assert(/redis\.set\(cacheKey, result, \{ ex: featureAccessTtlSeconds\(\) \}\)/.test(subs), 'the answer is not cached with featureAccessTtlSeconds');
    assert(!/\b86400\b/.test(subs), 'a flat 24-hour TTL is still there');
  });
}

async function main(): Promise<void> {
  await runAudit();
  await runGate();
  await runTtl();
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
