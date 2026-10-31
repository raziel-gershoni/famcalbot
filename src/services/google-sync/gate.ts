// In-process gate for the copy-to-Google worker (google-sync spec §2, The gate).
//
// The worker ticks every minute but reads the database only while the gate is open, so
// FamCal doesn't query Neon every minute and it can sleep. Every dirty mark opens the
// gate; after a run the worker closes it until its earliest retry, capped at the next whole
// UTC hour, so a mark this process never saw (another process, a lost flag on restart) is
// still picked up. The database stays the source of truth: a fresh process starts open.
//
// The gate itself is src/utils/pass-gate.ts (shared with the native reminders' due gate and
// the event alerts): its state is on globalThis.__googleSyncGate, shared by the scheduler
// bundle and the route bundles, and its header says why. Railway runs one instance; a second
// replica would need the gate in Redis.

import { PASS_GATE_CEILING_MS, createPassGate } from '../../utils/pass-gate';

/** The longest the gate stays closed: until the next whole UTC hour, at most an hour. */
export const SYNC_GATE_CEILING_MS = PASS_GATE_CEILING_MS;

const gate = createPassGate('__googleSyncGate');

/** Open the gate: the next shouldRunSync() returns true. */
export function openSyncGate(): void {
  gate.open();
}

/** True when the worker should read the database. Call it only right before running a pass. */
export function shouldRunSync(now: Date): boolean {
  return gate.shouldRun(now);
}

/** After a successful pass: sleep until the earliest retry, or the next whole UTC hour, whichever is sooner. */
export function setNextSync(next: Date | null, now: Date): void {
  gate.setNext(next, now);
}

/** Smoke scripts only: back to the state of a fresh process. Resets the shared object in place. */
export function __resetSyncGateForTests(): void {
  gate.reset();
}
