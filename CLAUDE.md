# CLAUDE.md

Rules for coding agents in this repo. Setup, env vars and deployment are in README.md.

- Never replace `ENCRYPTION_KEY` without setting `ENCRYPTION_KEY_PREVIOUS` to the old value in the same deploy, and remove `ENCRYPTION_KEY_PREVIOUS` only after the key sweep logs `[key-sweep] SAFE` (README, "Rotating `ENCRYPTION_KEY`").
- Turn a wall time into an instant only with `wallTimeToInstant` (`src/utils/wall-time.ts`, re-exported by `calendar-write/walltime.ts`): a time the clocks skip moves forward by the jump, a repeated one is its first occurrence, whatever zone the server runs in. Never `fromZonedTime`, and never move a `Date` by its local fields (`setHours`, `setDate`, `setSeconds`, ...): both depend on the server's zone, so use epoch arithmetic (`new Date(Date.now() - 24 * 60 * 60 * 1000)`) or the resolver. `scripts/smoke-dst.ts` fails on either (it re-runs itself under three process zones).
