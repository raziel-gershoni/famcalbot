// The one in-process gate for a pass that ticks often but should read the database only when
// it may have work: the native reminder pass (native-reminders/due-gate.ts), the copy to Google
// (google-sync/gate.ts) and the FamCal half of the event alerts (services/event-alerts-gate.ts).
// Neon suspends the database after 5 minutes without a query and bills every minute it is awake,
// so a pass that read on every tick kept it awake all day.
//
// After a pass, the gate stays closed until the time the pass said its next work is due, and
// never past the first whole UTC hour after the pass (nextTopOfHourUtc): a write this process
// never saw (another process, a flag lost on restart) is still picked up within the hour, and
// the ceiling read lands on :00, with the hourly jobs that wake the database anyway, instead of
// an hour after whatever minute the last read happened at. Every write that can add work opens
// the gate. The database stays the source of truth: a fresh process starts open.
//
// The state lives on globalThis under the gate's own key, the way src/utils/prisma.ts keeps
// global.prisma: Next 16 compiles instrumentation.ts (scheduler → cron handler) and the route
// handlers (webhook, admin, manual cron routes) into separate module instances, so a
// module-level variable would give each bundle its own gate, and a write made in a route would
// never wake the scheduler. Railway runs one instance; a second replica would need the gate in
// Redis.

const HOUR_MS = 60 * 60 * 1000;

/** The longest a gate stays closed: up to the next whole UTC hour, so at most an hour. */
export const PASS_GATE_CEILING_MS = HOUR_MS;

/** The first whole UTC hour after `now` (13:00:00 for 12:00:00 and for 12:59:59). By the epoch, never by local fields. */
export function nextTopOfHourUtc(now: Date): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
}

type PassGateState = {
  /** Epoch ms; the pass reads the database once now reaches it. 0 = on the next tick. */
  nextAt: number;
  /**
   * A write landed after the running pass went through the gate. That pass read the database
   * before the write, so its answer must not close the gate over it.
   */
  writtenSinceGate: boolean;
};

export interface PassGate {
  /** Open the gate: the next shouldRun() returns true, and a pass running now cannot close it. */
  open(): void;
  /** True when the pass should read the database. Call it only right before running the pass. */
  shouldRun(now: Date): boolean;
  /** After a successful pass: closed until `next`, or the next whole UTC hour, whichever is sooner. */
  setNext(next: Date | null, now: Date): void;
  /** Smoke scripts only: back to the state of a fresh process. Resets the shared object in place. */
  reset(): void;
}

/** The gate whose state is globalThis[globalKey], shared by every bundle of this process. */
export function createPassGate(globalKey: string): PassGate {
  const g = globalThis as unknown as Record<string, PassGateState | undefined>;
  const state = (g[globalKey] ??= { nextAt: 0, writtenSinceGate: false });
  return {
    open() {
      state.nextAt = 0;
      state.writtenSinceGate = true;
    },
    shouldRun(now) {
      if (now.getTime() < state.nextAt) return false;
      state.writtenSinceGate = false;
      return true;
    },
    setNext(next, now) {
      if (state.writtenSinceGate) return; // stays open, so the next tick reads that write
      const ceiling = nextTopOfHourUtc(now).getTime();
      state.nextAt = next ? Math.min(next.getTime(), ceiling) : ceiling;
    },
    reset() {
      state.nextAt = 0;
      state.writtenSinceGate = false;
    },
  };
}
