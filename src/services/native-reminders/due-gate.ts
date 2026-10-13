// In-process "next due" memo for the native reminder pass (spec §4.1, ruling R7).
//
// The pass ticks every minute but reads the database only when something may be
// due: after a pass the memo holds the earliest upcoming due time, capped an hour
// out so a write this process never saw is still picked up. Every reminder write
// and every snooze clears it.
//
// The memo is per process, shared by the scheduler bundle and the route bundles.
// Next 16 compiles instrumentation.ts (scheduler → cron handler) and the route
// handlers (webhook, admin, manual cron routes) into separate module instances, so
// a module-level variable would give each bundle its own memo, and a write made in
// a route would never wake the scheduler. The state therefore lives on globalThis,
// the way src/utils/prisma.ts keeps global.prisma. Railway runs one instance; a
// second replica would need the memo in Redis.

export const DUE_GATE_CEILING_MS = 60 * 60 * 1000;

type GateState = {
  /** Epoch ms; the pass reads the database once now reaches it. 0 = on the next tick. */
  nextDueAt: number;
  /**
   * A write landed after the running pass went through the gate. That pass read the
   * database before the write, so its answer must not close the gate over it.
   */
  writtenSinceGate: boolean;
};

const g = globalThis as { __nativeReminderDueGate?: GateState };
const gate = (g.__nativeReminderDueGate ??= { nextDueAt: 0, writtenSinceGate: false });

/** Clear the memo: the next shouldRunPass() returns true. */
export function invalidateDueGate(): void {
  gate.nextDueAt = 0;
  gate.writtenSinceGate = true;
}

/** True when the pass should read the database. Call it only right before running the pass. */
export function shouldRunPass(now: Date): boolean {
  if (now.getTime() < gate.nextDueAt) return false;
  gate.writtenSinceGate = false;
  return true;
}

/** After a successful pass: sleep until the earliest upcoming due, or the ceiling, whichever is sooner. */
export function setNextDue(next: Date | null, now: Date): void {
  if (gate.writtenSinceGate) return; // stays open, so the next tick reads that write
  const ceiling = now.getTime() + DUE_GATE_CEILING_MS;
  gate.nextDueAt = next ? Math.min(next.getTime(), ceiling) : ceiling;
}

/** Smoke scripts only: back to the state of a fresh process. Resets the shared object in place. */
export function __resetDueGateForTests(): void {
  gate.nextDueAt = 0;
  gate.writtenSinceGate = false;
}
