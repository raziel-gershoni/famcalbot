// What scripts/eval-voice-show.ts (a paid live eval) does around its paid calls: the spend notice and the --yes gate,
// and the run that stops at the first failed case. Kept apart so scripts/smoke-eval-voice-show.ts can test both with
// the paid steps stubbed.

export type EvalCheck = { name: string; ok: boolean; detail: string };

/**
 * A rough dollar cost for `cases` cases. The basis: eval-voice-show's own header ("roughly $0.02" a case, with the TTS
 * audio, from the runs of 2026-10). Without audio a case is only the writer and the gender judge, two or three LLM
 * calls; $0.005 is a guess at that, not a measurement. It is a notice to decide on, not a bill.
 */
export function estimateCost(cases: number, audio: boolean): number {
  return cases * (audio ? 0.02 : 0.005);
}

/** Prints the count and the estimate; true only when the run was started with --yes (otherwise the caller exits). */
export function confirmSpend(args: { cases: number; audio: boolean; yes: boolean }, log: (line: string) => void): boolean {
  const cost = `about $${estimateCost(args.cases, args.audio).toFixed(2)}`;
  log(`${args.cases} case(s) to run${args.audio ? ' with audio' : ' without audio'}, estimated ${cost} of paid LLM${args.audio ? ' and TTS' : ''} calls.`);
  if (!args.yes) log('Nothing was run. Run again with --yes to spend it.');
  return args.yes;
}

/**
 * Runs the cases in order and stops after the first one that has a failed check or throws, saying which and why.
 * `stopped` is "<case>/<check>" of that failure, or null when every case passed.
 */
export async function runEvalCases<T>(
  cases: readonly T[],
  runCase: (c: T) => Promise<EvalCheck[]>,
  nameOf: (c: T) => string,
  log: (line: string) => void,
): Promise<{ report: Array<{ name: string; checks: EvalCheck[] }>; stopped: string | null }> {
  const report: Array<{ name: string; checks: EvalCheck[] }> = [];
  for (const c of cases) {
    const name = nameOf(c);
    let checks: EvalCheck[];
    try {
      checks = await runCase(c);
    } catch (error) {
      checks = [{ name: 'run', ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }];
    }
    report.push({ name, checks });
    const failure = checks.find(k => !k.ok);
    if (failure) {
      log(`\nStopped at the first failed case: ${name} / ${failure.name}: ${failure.detail}`);
      return { report, stopped: `${name}/${failure.name}` };
    }
  }
  return { report, stopped: null };
}
