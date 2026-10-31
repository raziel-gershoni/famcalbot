// In-process "next due" memo for the native reminder pass (spec §4.1, ruling R7).
//
// The pass ticks every minute but reads the database only when something may be
// due: after a pass the memo holds the earliest upcoming due time, capped at the next
// whole UTC hour so a write this process never saw is still picked up. Every reminder
// write and every snooze clears it.
//
// The gate itself is src/utils/pass-gate.ts (shared with the copy to Google and the event
// alerts): its state is on globalThis.__nativeReminderDueGate, shared by the scheduler bundle
// and the route bundles, and its header says why. Railway runs one instance; a second replica
// would need the memo in Redis.

import { PASS_GATE_CEILING_MS, createPassGate } from '../../utils/pass-gate';

/** The longest the memo sleeps: until the next whole UTC hour, at most an hour. */
export const DUE_GATE_CEILING_MS = PASS_GATE_CEILING_MS;

const gate = createPassGate('__nativeReminderDueGate');

/** Clear the memo: the next shouldRunPass() returns true. */
export function invalidateDueGate(): void {
  gate.open();
}

/** True when the pass should read the database. Call it only right before running the pass. */
export function shouldRunPass(now: Date): boolean {
  return gate.shouldRun(now);
}

/** After a successful pass: sleep until the earliest upcoming due, or the next whole UTC hour, whichever is sooner. */
export function setNextDue(next: Date | null, now: Date): void {
  gate.setNext(next, now);
}

/** Smoke scripts only: back to the state of a fresh process. Resets the shared object in place. */
export function __resetDueGateForTests(): void {
  gate.reset();
}
