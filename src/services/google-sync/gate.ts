// In-process gate for the copy-to-Google worker (google-sync spec §2, The gate).
//
// The worker ticks every minute but reads the database only while the gate is open, so
// FamCal doesn't query Neon every minute and it can sleep. Every dirty mark opens the
// gate; after a run the worker closes it until its earliest retry, capped an hour out, so
// a mark this process never saw (another process, a lost flag on restart) is still
// picked up. The database stays the source of truth: a fresh process starts open.
//
// The state lives on globalThis, as src/services/native-reminders/due-gate.ts does: Next 16
// compiles instrumentation.ts (scheduler → cron handler) and the route handlers into
// separate module instances, so a module-level variable would give each bundle its own
// gate, and a mark made in a route would never wake the scheduler. Railway runs one
// instance; a second replica would need the gate in Redis.

export const SYNC_GATE_CEILING_MS = 60 * 60 * 1000;

type GateState = {
  /** Epoch ms; the worker reads the database once now reaches it. 0 = on the next tick. */
  nextRunAt: number;
  /**
   * A mark landed after the running pass went through the gate. That pass may have read
   * the database before the mark committed, so its answer must not close the gate over it.
   */
  markedSinceGate: boolean;
};

const g = globalThis as { __googleSyncGate?: GateState };
const gate = (g.__googleSyncGate ??= { nextRunAt: 0, markedSinceGate: false });

/** Open the gate: the next shouldRunSync() returns true. */
export function openSyncGate(): void {
  gate.nextRunAt = 0;
  gate.markedSinceGate = true;
}

/** True when the worker should read the database. Call it only right before running a pass. */
export function shouldRunSync(now: Date): boolean {
  if (now.getTime() < gate.nextRunAt) return false;
  gate.markedSinceGate = false;
  return true;
}

/** After a successful pass: sleep until the earliest retry, or the ceiling, whichever is sooner. */
export function setNextSync(next: Date | null, now: Date): void {
  if (gate.markedSinceGate) return; // stays open, so the next tick reads that mark
  const ceiling = now.getTime() + SYNC_GATE_CEILING_MS;
  gate.nextRunAt = next ? Math.min(next.getTime(), ceiling) : ceiling;
}

/** Smoke scripts only: back to the state of a fresh process. Resets the shared object in place. */
export function __resetSyncGateForTests(): void {
  gate.nextRunAt = 0;
  gate.markedSinceGate = false;
}
