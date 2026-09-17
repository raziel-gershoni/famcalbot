# Admin: comped premium grants and per-user activity

**Date:** 2026-09-17
**Status:** Approved

Two admin-panel capabilities, both landing in the per-user detail card that
already exists inside the "User Feature Overrides" section:

- **(A)** Click a user, see that user's actions from the log.
- **(B)** Grant PRO to any user and revoke it at will.

## Why these are different sizes

(A) is almost entirely built. `UserActivity` is a real Postgres table, and
`GET /api/admin/user-activity?user_id=` already filters by user
(`route.ts:39-48`). The client already declares `activityUserFilter` and
already appends it to the request (`AdminPanelClient.tsx:209,377`) — but
`setActivityUserFilter` is never called anywhere in the repo, and the i18n key
`admin.activity.filterByUser` exists in all three locales with zero call sites.
The work is UI.

(B) does not exist at any layer. Nothing under `app/api/admin/` writes to
`Subscription`. `upgradeSubscription()` is reachable only from the Telegram
Stars payment webhook (`payment-handler.ts:162`). Admin grants today are
feature-override booleans, which unlock gates but leave the user reading as
FREE on their own dashboard.

## Decisions

| Question | Decision |
|---|---|
| What does "premium" change? | A real `Subscription` row (`plan=PRO, status=ACTIVE`) plus a comp marker |
| How does a comp end? | Never, except manual revoke. The billing cron skips comps. |
| Who can be comped? | Only users without current paid access. Refuse `TRIALING`/`ACTIVE`. |
| Is the user notified? | No. Silent on both grant and revoke. |

## 1. Schema

```prisma
model Subscription {
  compedBy    Int?       // admin User.id; NULL means "not a comp"
  compedAt    DateTime?
  compReason  String?
}

model UserActivity {
  @@index([userId, createdAt])
}
```

`compedBy IS NULL` is the sole discriminator — no new enum value, no new
status. A comped row is `plan=PRO, status=ACTIVE, currentPeriodStart=now,
currentPeriodEnd=NULL`.

The NULL period end is deliberate defence in depth: the expiry cron's
predicate is `currentPeriodEnd < now`, which can never match NULL, so a comp
survives even if someone later removes the explicit `compedBy` guard.

**Migration:** `prisma/migrations/20260917000000_admin_comped_subscriptions/migration.sql`,
hand-authored. `Subscription` and `UserActivity` were created by `prisma db
push` and appear in no migration file, so `prisma migrate dev` cannot generate
a clean diff. Every statement uses `IF NOT EXISTS`.

**Known inherited hazard:** a *fresh* database would fail this ALTER, since no
migration ever creates `Subscription`. That is already true of the repo today
and is not addressed here.

## 2. Service layer

Two new exported functions in `src/services/subscription-service.ts`. They
deliberately do not reuse `upgradeSubscription()`, which stamps a one-month
`currentPeriodEnd` and is the payment path.

```ts
grantCompedSubscription(userId: number, adminId: number, reason?: string)
  : Promise<{ ok: true; subscription: Subscription }
          | { ok: false; code: 'ALREADY_ACTIVE'; plan: string; status: string }>

revokeCompedSubscription(userId: number, adminId: number)
  : Promise<{ ok: true } | { ok: false; code: 'NOT_COMPED' }>
```

**Grant** refuses when the user already has paid access, then writes
PRO/ACTIVE + comp fields, resets usage counters (matching
`upgradeSubscription`'s behaviour), writes a `UserActivity` row, and
invalidates the feature-access cache.

**Refusal rule.** Reject when status is `TRIALING` or `ACTIVE`, and also when
status is `CANCELED` with `currentPeriodEnd` still in the future — a canceled
subscriber keeps paid access until period end, and overwriting it would take
away something they paid for.

**Revoke** refuses when `compedBy IS NULL`, so a real paying customer can never
be downgraded through this path. Otherwise FREE/EXPIRED, comp fields cleared,
activity logged, cache invalidated. Revoke does **not** reset usage counters —
the counters were already zeroed at grant time, and zeroing them again would
hand a revoked user a fresh free quota.

**Users with no subscription row.** A user who has never had a subscription
has no `Subscription` record. Grant must `create` one directly in the comped
state; it must not call `getOrCreateSubscription()`, which would first write a
`TRIALING` row with a 14-day trial and thereby trip the refusal rule against
itself.

## 3. New route

`app/api/admin/subscription/route.ts` — `POST` grants, `DELETE` revokes. A
separate file rather than an addition to `user-overrides/route.ts`, which is
already 555 lines and concerns a different table.

Follows every established convention: `verifyAdminAccess(initData)`, the
`auth.error === 'Admin access required' ? 403 : 401` ternary, `{ success: true }`
and `{ error }` envelopes, `Number(telegramId)` serialization,
`captureError(err, 'admin-subscription-post', { api_route: ... })`, and
`export const dynamic = 'force-dynamic'`. `initData` arrives in the JSON body
for POST and the query string for DELETE.

A refused grant returns `409` with the user's current plan and status in the
message.

## 4. Revocation must be immediate

Revocation is worthless if access lingers behind a 24h cache. Three existing
defects block it and are fixed here:

- `app/api/admin/user-overrides/route.ts:434` (POST remove-override branch) and
  `:531` (DELETE handler) delete the override row without calling
  `invalidateFeatureAccessCache`.
- `expireSubscriptions` (`src/services/subscription-reminders.ts:277-283`)
  writes `EXPIRED/FREE` with no invalidation.

`expireSubscriptions` additionally gets `compedBy: null` added to its `where`
clause so it never expires a comp.

`processSubscriptionReminders` must be verified not to send renewal reminders
to a comped user. With `currentPeriodEnd = NULL` it should not match, but this
is confirmed rather than assumed — the user chose silent, and a "renew your
subscription" message to someone who was comped would break that.

## 5. Per-user activity timeline

The backend needs no change. In `AdminPanelClient.tsx`:

- Isolated state (`userActivity`, `userActivityOffset`, `userActivityHasMore`,
  `userActivityLoading`) rather than sharing the global Activity section's
  state — sharing would empty the global list whenever a user was selected.
- `fetchUserActivity(userId)` is called from inside the existing
  `loadUserDetails()`, so the timeline arrives with the card.
- Renders the 5 most recent, with "Show more" paging 20 at a time against the
  endpoint's existing offset pagination.
- The dead `activityUserFilter` state is deleted.

No action-filter dropdown in the card: the endpoint's `actionStats` are
computed with no `where` clause and are therefore global, so per-user counts
would be wrong.

`metadata` is an untyped `Json?` whose shape varies by action, so it renders
defensively.

**Coverage caveat.** Only 22 of the 38 declared `ActivityAction` values are ever
written. Timelines will show nothing for messages received, commands run,
webapp opens, settings changes, calendar connections or syncs — those exist
only as Sentry breadcrumbs. Adding that instrumentation is out of scope.

## 6. Tying the two together

Two new `ActivityAction` values — `admin_granted_premium` and
`admin_revoked_premium` — written by the grant/revoke functions with
`{ adminId, reason }` metadata. Grants then appear in the timeline built in
section 5, which becomes the repo's only persistent record of admin action
beyond `console.log`.

Rows are attributed to the *target* user, which is what the card wants to show.
The acting admin lives in metadata.

## 7. Card layout

Subscription → Usage → Registration → Platform → Feature Overrides →
**Comped Premium** → **Activity** → Moderation.

Actions first, history next, destructive last.

The Comped Premium block shows current comp state and one button that flips
between Grant and Revoke, plus a reason input matching the existing
`overrides.reasonPlaceholder` pattern.

**Early-adoption warning.** The client already receives `earlyAdoptionMode` as
a prop. While that global flag is on, `checkEarlyAdopterAccess` returns true for
every user before any per-user check runs, so a grant has no observable effect.
The block says so rather than letting an admin grant into a void.

## 8. i18n

A new `admin.comp.*` group between `overrides` and `openDashboard`, plus
additions to `admin.activity.*`. All three locales, written naturally per
language rather than translated literally. Parameterised strings use the
repo's hand-rolled `{placeholder}` + `.replace()` convention, not ICU.

## 9. Verification

There is no test framework in this repo — no vitest, no jest, no `test` script.
Verification is `tsc --noEmit`, a production build, and a throwaway script
exercising grant → revoke → re-grant against the API. Introducing a test runner
is a separate decision and is not made here.

## 10. Out of scope, flagged

`app/api/admin/analytics/route.ts:37-52` has an auth bypass: the initData check
is `if (initData && !verifyUserAccess(...))`, so a request with no initData
skips verification entirely and needs only a known admin Telegram ID. The same
pattern appears at `app/api/subscription/upgrade/route.ts:55`. Unrelated to this
work; reported, not fixed.
