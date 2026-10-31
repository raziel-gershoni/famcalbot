// In-process gate for the FamCal half of the 5-minute event alerts pass (event alerts gate spec,
// docs/superpowers/specs/2026-10-31-event-alerts-gate-design.md).
//
// The pass reads Google for its Google users on every run (network, no database), but the
// FamCal half reads the database: the calendars each user sees and their events. Neon suspends
// the database after 5 minutes without a query, so reading it every 5 minutes kept it awake all
// day. While this gate is closed the pass skips the FamCal half for everyone; when it is open,
// the pass reads FamCal as it always did and says when the next FamCal alert is due, and the
// gate closes until the tick whose window holds that alert (the first tick after the alert
// minus the window: setNextFamcalAlert), or the next whole UTC hour, whichever is sooner.
//
// The database stays the source of truth: every FamCal alert sent follows a fresh read in the
// same pass. Any write that can add an alert or move one earlier opens the gate (one global
// flag, so a write never has to know which users it affects): the event store's four writes,
// the calendar PATCH, an account merge, the reminder cache's entries (a pairing reaches the pass
// at the next hourly sync, which opens it), a plan regained, and the manual run
// (scripts/smoke-alerts-gate-writers.ts lists every writer). A fresh process starts open.
//
// A pass whose FamCal read failed for a user keeps the gate open, so the next tick reads again
// (settleFamcalFailures). Not for good: a user who has failed for 15 minutes while another
// user's read succeeds in the same pass stops holding it (that user's read fails on every retry,
// and holding it kept the database awake all day), and no failure holds it for more than an
// hour, even when every read fails (prod may have a single cached user, failing for any cause).
// After that a failing pass closes the gate to the usual ceiling, so the next :00 pass retries:
// an outage costs one read an hour, alerts are back within the hour after it, and any write
// still opens the gate at once.
//
// The state is on globalThis (src/utils/pass-gate.ts says why), and so is the pass token: two
// passes can overlap (a manual run beside a scheduled one, or one slower than 5 minutes), and
// only the latest pass that read FamCal may close the gate, so an older pass's view never closes
// it over a write the newer one read. Railway runs one instance; a second replica would need
// the gate in Redis.

import { createPassGate } from '../utils/pass-gate';

/** How long a user whose FamCal read keeps failing holds the gate open, while others read cleanly. */
export const FAMCAL_FAILURE_HOLD_MS = 15 * 60 * 1000;
/** The longest any failure holds the gate open, also when every read fails: then the next :00 retries. */
export const FAMCAL_FAILURE_MAX_HOLD_MS = 60 * 60 * 1000;
/** A held or dropped hold is reported to Sentry at most this often (each pass still logs it). */
export const FAMCAL_HOLD_REPORT_INTERVAL_MS = 60 * 60 * 1000;

const gate = createPassGate('__eventAlertsGate');

type EventAlertsCronState = {
  token: number;
  /** Per user id: when their FamCal read began failing (epoch ms), cleared by their next clean read. */
  failingSince: Record<number, number>;
  /** When each kind of hold report last went to Sentry (epoch ms). */
  reportedAt: { held: number; dropped: number };
};
const passes = ((globalThis as { __eventAlertsCron?: EventAlertsCronState }).__eventAlertsCron ??= {
  token: 0,
  failingSince: {},
  reportedAt: { held: 0, dropped: 0 },
});

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
 * After a pass that read FamCal with no user holding the gate (settleFamcalFailures): closed
 * until `next`, or the next whole UTC hour, whichever is sooner. `next` is the earliest FamCal
 * alert time minus the pass's window, plus 1 ms: the gate opens on the first tick after that,
 * the tick whose window holds the alert (the tick at exactly the alert minus the window covers
 * the window before it, and would read for nothing). Ignored when a later pass read FamCal since
 * this one started (its token is not the latest), or when a write landed since this pass began.
 */
export function setNextFamcalAlert(next: Date | null, now: Date, token: number): void {
  if (token !== passes.token) return;
  gate.setNext(next, now);
}

/** What an open pass's FamCal reads came to: the users whose read failed (or whose pass threw), and those whose read succeeded. */
export interface FamcalPassOutcome {
  failed: number[];
  ok: number[];
  /** Every user the pass went through: failures of users no longer cached are forgotten. */
  seen: number[];
}

/** What settleFamcalFailures decided for a pass. */
export interface FamcalHolds {
  /** The failing users who still hold the gate open. */
  held: number[];
  /** The failing users who no longer do. */
  dropped: number[];
  /** How long the oldest failure has lasted (ms). */
  oldestFailingMs: number;
  /** When the held users stop holding, if they keep failing (null with none held). */
  stopsHoldingAt: Date | null;
}

/**
 * Which failures hold the gate open after an open pass. A user's first failure starts their
 * clock and their next clean read clears it. A failing user stops holding (dropped) after
 * FAMCAL_FAILURE_HOLD_MS when another user's read succeeded in the same pass, and after
 * FAMCAL_FAILURE_MAX_HOLD_MS in any case; until then they hold it.
 */
export function settleFamcalFailures(outcome: FamcalPassOutcome, now: Date): FamcalHolds {
  const at = now.getTime();
  const seen = new Set(outcome.seen);
  for (const id of Object.keys(passes.failingSince).map(Number)) {
    if (!seen.has(id)) delete passes.failingSince[id];
  }
  for (const id of outcome.ok) delete passes.failingSince[id];
  for (const id of outcome.failed) passes.failingSince[id] ??= at;
  const limitMs = outcome.ok.length > 0 ? FAMCAL_FAILURE_HOLD_MS : FAMCAL_FAILURE_MAX_HOLD_MS;
  const held: number[] = [];
  const dropped: number[] = [];
  let oldestFailingMs = 0;
  let stopsHoldingAt = 0;
  for (const id of outcome.failed) {
    const failingMs = at - passes.failingSince[id];
    oldestFailingMs = Math.max(oldestFailingMs, failingMs);
    if (failingMs >= limitMs) {
      dropped.push(id);
    } else {
      held.push(id);
      stopsHoldingAt = Math.max(stopsHoldingAt, passes.failingSince[id] + limitMs);
    }
  }
  return { held, dropped, oldestFailingMs, stopsHoldingAt: held.length > 0 ? new Date(stopsHoldingAt) : null };
}

/** True at most once per FAMCAL_HOLD_REPORT_INTERVAL_MS for each kind: whether this pass sends that report to Sentry. */
export function holdReportDue(kind: 'held' | 'dropped', now: Date): boolean {
  if (now.getTime() - passes.reportedAt[kind] < FAMCAL_HOLD_REPORT_INTERVAL_MS) return false;
  passes.reportedAt[kind] = now.getTime();
  return true;
}

/** Smoke scripts only: back to the state of a fresh process. Resets the shared objects in place. */
export function __resetEventAlertsGateForTests(): void {
  gate.reset();
  passes.token = 0;
  passes.failingSince = {};
  passes.reportedAt = { held: 0, dropped: 0 };
}
