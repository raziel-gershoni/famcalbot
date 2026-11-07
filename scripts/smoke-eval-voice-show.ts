// Guard for scripts/eval-voice-show.ts, the paid live eval of the two-host show: it stops at the first failed case
// (and says which and why), and it prints the case count and an estimated cost and exits before any paid call unless
// it is run with --yes. The paid steps are stubbed here (a case is a stub function), and the real script is run as a
// child with no --yes and a fake key: it must print the estimate and exit without reaching the writer or the network.
// With --format calm it runs the calm single voice; an unknown format stops before the spend notice.
// Nothing is paid, nothing touches the network or the database.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { confirmSpend, estimateCost, runEvalCases, type EvalCheck } from './lib/eval-spend';

const ROOT = path.resolve(__dirname, '..');
const results: { name: string; ok: boolean; reason?: string }[] = [];
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
const ok = (name: string): EvalCheck => ({ name, ok: true, detail: 'fine' });
const bad = (name: string, detail: string): EvalCheck => ({ name, ok: false, detail });

async function main() {
  await check('#1 the run stops at the first failed case: later cases are never run, the failing one is named with its check and why, and the cases before it are in the report', async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const { report, stopped } = await runEvalCases(['a', 'b', 'c', 'd'], async (c) => {
      ran.push(c);
      return c === 'b' ? [ok('facts'), bad('gender', 'wrong verb')] : [ok('facts')];
    }, (c) => c, (l) => lines.push(l));
    assert(show(ran) === show(['a', 'b']), `the cases run: ${show(ran)}`);
    assert(show(report.map(r => r.name)) === show(['a', 'b']), `the report: ${show(report.map(r => r.name))}`);
    assert(stopped === 'b/gender', `stopped: ${show(stopped)}`);
    assert(lines.some(l => l.includes('b') && l.includes('gender') && l.includes('wrong verb')), `the stop line: ${show(lines)}`);
  });

  await check('#2 a case that throws is a failure too (it stops the run); a run with no failure goes through every case and stops nowhere', async () => {
    const ran: string[] = [];
    const thrown = await runEvalCases([1, 2, 3], async (n) => {
      ran.push(String(n));
      if (n === 2) throw new Error('provider down');
      return [ok('x')];
    }, (n) => `case${n}`, () => {});
    assert(show(ran) === show(['1', '2']) && thrown.stopped === 'case2/run', `${show(ran)} ${show(thrown.stopped)}`);
    const clean = await runEvalCases([1, 2, 3], async () => [ok('x')], (n) => `case${n}`, () => {});
    assert(clean.report.length === 3 && clean.stopped === null, `a clean run: ${show(clean)}`);
  });

  await check('#3 the spend gate: it prints the case count and a cost and says no without --yes; with --yes it says go; the estimate grows with the cases and is higher with audio', () => {
    const lines: string[] = [];
    assert(confirmSpend({ cases: 6, audio: true, yes: false }, (l) => lines.push(l)) === false, 'no --yes went ahead');
    assert(lines.join('\n').includes('6 case') && /\$\d/.test(lines.join('\n')) && lines.join('\n').includes('--yes'), `the notice: ${show(lines)}`);
    const go: string[] = [];
    assert(confirmSpend({ cases: 6, audio: true, yes: true }, (l) => go.push(l)) === true, '--yes did not go ahead');
    assert(go.join('\n').includes('6 case'), `with --yes it still states the count: ${show(go)}`);
    assert(estimateCost(6, true) > estimateCost(3, true) && estimateCost(3, true) > estimateCost(3, false) && estimateCost(0, true) === 0, 'the estimate');
  });

  await check('#4 the real script, run with no --yes, a fake key and the Hebrew cases: it prints the count and the estimate, exits non-zero and writes nothing (no case is reached)', () => {
    const run = spawnSync(process.execPath, ['-r', 'tsx/cjs', 'scripts/eval-voice-show.ts', path.join(ROOT, 'node_modules/.cache/eval-voice-show-smoke'), '--lang', 'he'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', // a script that ignores the gate would start its (fake-key) calls; the smoke cuts it off
      env: { ...process.env, GEMINI_API_KEY: 'fake' },
    });
    const out = `${run.stdout}${run.stderr}`;
    assert(run.status === 1 && run.signal === null, `exit ${run.status} (signal ${run.signal}): it went on past the gate: ${out}`);
    assert(/\$\d/.test(out) && out.includes('--yes') && /\d+ case/.test(out), `the notice: ${out}`);
    assert(!out.includes('===') && !out.includes('FAIL') && !out.includes('OK  '), `a case ran: ${out}`);
  });

  await check('#5 the real script with --format calm, the three Hebrew daily cases and no --yes: it prints 3 cases and the estimate, exits non-zero and runs none', () => {
    const run = spawnSync(process.execPath, ['-r', 'tsx/cjs', 'scripts/eval-voice-show.ts', path.join(ROOT, 'node_modules/.cache/eval-voice-show-smoke'), '--format', 'calm', '--lang', 'he', '--only', 'daily-male-busy,daily-female-empty,daily-female-busy'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      env: { ...process.env, GEMINI_API_KEY: 'fake' },
    });
    const out = `${run.stdout}${run.stderr}`;
    assert(run.status === 1 && run.signal === null, `exit ${run.status} (signal ${run.signal}): ${out}`);
    assert(out.includes('3 case') && /\$\d/.test(out) && out.includes('--yes'), `the notice: ${out}`);
    assert(!out.includes('===') && !out.includes('FAIL') && !out.includes('OK  '), `a case ran: ${out}`);
  });

  await check('#6 an unknown --format stops before the spend notice and runs nothing', () => {
    const run = spawnSync(process.execPath, ['-r', 'tsx/cjs', 'scripts/eval-voice-show.ts', path.join(ROOT, 'node_modules/.cache/eval-voice-show-smoke'), '--format', 'loud', '--yes'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      env: { ...process.env, GEMINI_API_KEY: 'fake' },
    });
    const out = `${run.stdout}${run.stderr}`;
    assert(run.status === 1 && out.includes('Unknown --format') && !out.includes('case(s) to run') && !out.includes('==='), `exit ${run.status}: ${out}`);
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
