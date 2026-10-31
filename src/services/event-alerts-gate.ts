// In-process gate for the FamCal half of the 5-minute event alerts pass (event alerts gate spec,
// docs/superpowers/specs/2026-10-31-event-alerts-gate-design.md).
//
// The pass reads Google for its Google users on every run (network, no database), but the
// FamCal half reads the database: the calendars each user sees and their events. Neon suspends
// the database after 5 minutes without a query, so reading it every 5 minutes kept it awake all
// day. While this gate is closed the pass skips the FamCal half for everyone; when it is open,
// the pass reads FamCal as it always did and says when the next FamCal alert is due, and the
// gate closes until the tick whose window holds that alert, or the next whole UTC hour,
// whichever is sooner.
//
// The database stays the source of truth: every FamCal alert sent follows a fresh read in the
// same pass. Any write that can add an alert or move one earlier opens the gate (one global
// flag, so a write never has to know which users it affects): the event store's four writes,
// the calendar PATCH, a pairing, an account merge, the reminder cache's entries, a plan regained,
// and the manual run (scripts/smoke-alerts-gate-writers.ts lists every writer). A fresh process
// starts open.
//
// The state is on globalThis (src/utils/pass-gate.ts says why), and so is the pass token: two
// passes can overlap (a manual run beside a scheduled one, or one slower than 5 minutes), and
// only the latest pass that read FamCal may close the gate, so an older pass's view never closes
// it over a write the newer one read. Railway runs one instance; a second replica would need
// the gate in Redis.

import { createPassGate } from '../utils/pass-gate';

const gate = createPassGate('__eventAlertsGate');

type EventAlertsCronState = { token: number };
const passes = ((globalThis as { __eventAlertsCron?: EventAlertsCronState }).__eventAlertsCron ??= { token: 0 });

/** Open the gate: the next pass reads FamCal, and a pass running now cannot close it. */
export function openEventAlertsGate(): void {
  gate.open();
}

/** True when this pass reads the FamCal half. Call it once per pass, right before the pass. */
export function shouldReadFamcal(now: Date): boolean {
  return gate.shouldRun(now);
}

/** The token of a pass that reads FamCal (after shouldReadFamcal said so): only the latest may close the gate. */
export function startFamcalPass(): number {
  passes.token += 1;
  return passes.token;
}

/**
 * After a pass that read FamCal for every user without a failure: closed until `next`, the
 * earliest FamCal alert time minus the pass's window (so the tick whose window holds it opens),
 * or the next whole UTC hour, whichever is sooner. Ignored when a later pass read FamCal since
 * this one started (its token is not the latest), or when a write landed since this pass began.
 */
export function setNextFamcalAlert(next: Date | null, now: Date, token: number): void {
  if (token !== passes.token) return;
  gate.setNext(next, now);
}

/** Smoke scripts only: back to the state of a fresh process. Resets the shared objects in place. */
export function __resetEventAlertsGateForTests(): void {
  gate.reset();
  passes.token = 0;
}
