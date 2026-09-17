# Admin Comped Premium & Per-User Activity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin open a user in the admin panel, see that user's action log, and grant or revoke a free ("comped") PRO subscription at will.

**Architecture:** A comped subscription is a real `Subscription` row (`plan=PRO`, `status=ACTIVE`) marked by a new nullable `compedBy` column, with `currentPeriodEnd = NULL` so the billing cron can never expire it. Grant refuses anyone who already has paid access; revoke refuses anyone who is not comped. The activity timeline reuses the existing `/api/admin/user-activity` endpoint, which already filters by `user_id` — only the client is missing.

**Tech Stack:** Next.js 15 App Router, Prisma + Neon Postgres, Upstash Redis, next-intl (en/he/ru), Telegram Mini App client.

**Spec:** `docs/superpowers/specs/2026-09-17-admin-comped-premium-and-user-activity-design.md`

## Global Constraints

- **No test framework exists.** There is no vitest, jest, or `test` script in `package.json`. Every task below verifies with a runnable command — `npm run type-check`, `npm run build`, or a throwaway `npx tsx` script — not with unit tests. Do not add a test runner; that is a separate decision.
- **All three locales stay in sync.** `messages/en.json`, `he.json`, `ru.json` have identical key structure (816 leaf keys each) enforced by discipline alone. Any key added to one must be added to all three.
- **Translations are written naturally per language, never translated literally.**
- **Parameterised strings use the repo's hand-rolled convention**, not ICU: `t('x.y').replace('{count}', String(n))`.
- **Admin route contract:** `verifyAdminAccess(initData)`; on failure `NextResponse.json({ error: auth.error }, { status: auth.error === 'Admin access required' ? 403 : 401 })`. Success is `{ success: true, ... }`, failure is `{ error: string }`. `export const dynamic = 'force-dynamic'` at the top. Errors funnel through `captureError(err, '<kebab-context>', { api_route: '<path>' })`.
- **`initData` transport:** JSON body for POST, query string for GET/DELETE.
- **`telegramId` is `BigInt?`** — always serialize as `user.telegramId ? Number(user.telegramId) : null` or `JSON.stringify` throws.
- **`auth.adminId` is the internal `User.id`**, not a telegramId.
- **Migrations are hand-authored.** `Subscription` and `UserActivity` were created by `prisma db push` and appear in no migration file, so `prisma migrate dev` cannot produce a clean diff. Name migrations `YYYYMMDD000000_description`. `npm run build` runs `prisma migrate deploy`.
- **The admin panel is a mobile Telegram Mini App.** No hover states; touch targets only; all information inline.

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (model `Subscription` ~line 276, model `UserActivity` ~line 320)
- Create: `prisma/migrations/20260917000000_admin_comped_subscriptions/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `Subscription.compedBy: number | null`, `Subscription.compedAt: Date | null`, `Subscription.compReason: string | null` on the generated Prisma client; index `UserActivity_userId_createdAt_idx`.

- [ ] **Step 1: Add the three columns to `Subscription`**

In `prisma/schema.prisma`, inside `model Subscription`, immediately after the `cancelAtPeriodEnd` line:

```prisma
  // Admin-granted ("comped") access. compedBy IS NULL means this is a real
  // subscription; non-null means an admin gave it away for free. A comped row
  // has currentPeriodEnd = NULL so the expiry cron can never match it.
  compedBy   Int? // admin User.id who granted it
  compedAt   DateTime?
  compReason String?
```

- [ ] **Step 2: Add the composite index to `UserActivity`**

In `model UserActivity`, replace the index block:

```prisma
  @@index([userId])
  @@index([action])
  @@index([createdAt])
  @@index([userId, createdAt])
```

- [ ] **Step 3: Hand-author the migration**

Create `prisma/migrations/20260917000000_admin_comped_subscriptions/migration.sql`:

```sql
-- Admin-granted ("comped") subscriptions.
--
-- Subscription and UserActivity were created with `prisma db push` and appear in
-- no earlier migration, so this file is written by hand rather than generated,
-- and every statement is idempotent.

ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "compedBy" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "compedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "compReason" TEXT;

-- Serves the per-user, newest-first activity timeline in the admin panel.
CREATE INDEX IF NOT EXISTS "UserActivity_userId_createdAt_idx"
  ON "UserActivity"("userId", "createdAt");
```

- [ ] **Step 4: Regenerate the client and verify it compiles**

Run: `npx prisma generate && npm run type-check`
Expected: generate succeeds, `tsc --noEmit` exits 0.

- [ ] **Step 5: Verify the generated types actually carry the new fields**

Run: `npx tsx -e "import type { Subscription } from '@prisma/client'; const s = {} as Subscription; void s.compedBy; void s.compedAt; void s.compReason; console.log('comp fields present on Subscription')"`
Expected: prints `comp fields present on Subscription` with no type error.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260917000000_admin_comped_subscriptions/
git commit -m "feat(schema): add comped-subscription columns and per-user activity index"
```

---

### Task 2: Grant and revoke service functions

**Files:**
- Modify: `src/services/analytics-service.ts:10-64` (ActivityAction union), `:66-106` (ActivityMetadata)
- Modify: `src/services/subscription-service.ts` (append after `upgradeSubscription`, which ends ~line 212)

**Interfaces:**
- Consumes: `Subscription.compedBy/compedAt/compReason` from Task 1; existing `trackActivity`, `invalidateFeatureAccessCache`, `prisma`.
- Produces:
  ```ts
  type CompGrantResult =
    | { ok: true; subscription: Subscription }
    | { ok: false; code: 'ALREADY_COMPED' }
    | { ok: false; code: 'ALREADY_ACTIVE'; plan: string; status: string };
  type CompRevokeResult = { ok: true } | { ok: false; code: 'NOT_COMPED' };
  grantCompedSubscription(userId: number, adminId: number, reason?: string): Promise<CompGrantResult>
  revokeCompedSubscription(userId: number, adminId: number): Promise<CompRevokeResult>
  ```
  Activity actions `'admin_granted_premium'` and `'admin_revoked_premium'`.

- [ ] **Step 1: Add the two admin activity actions**

In `src/services/analytics-service.ts`, inside the `ActivityAction` union, immediately after the `| 'feature_blocked'` line:

```ts
  // Admin actions (attributed to the target user; the acting admin is in metadata)
  | 'admin_granted_premium'
  | 'admin_revoked_premium'
```

- [ ] **Step 2: Add their metadata fields**

In `ActivityMetadata`, immediately before the `// Generic` comment:

```ts
  // Admin actions
  admin_id?: number;
  reason?: string | null;
```

- [ ] **Step 3: Add the paid-access predicate**

Append to `src/services/subscription-service.ts`, after `upgradeSubscription`:

```ts
// ============================================
// ADMIN-GRANTED ("COMPED") SUBSCRIPTIONS
// ============================================

export type CompGrantResult =
  | { ok: true; subscription: Subscription }
  | { ok: false; code: 'ALREADY_COMPED' }
  | { ok: false; code: 'ALREADY_ACTIVE'; plan: string; status: string };

export type CompRevokeResult =
  | { ok: true }
  | { ok: false; code: 'NOT_COMPED' };

/**
 * Does this subscription currently confer paid access?
 *
 * TRIALING and ACTIVE obviously do. CANCELED still does until the period ends —
 * the user paid for that time and an admin grant must not quietly overwrite it.
 */
function hasPaidAccess(sub: Subscription, now: Date): boolean {
  if (sub.status === 'TRIALING' || sub.status === 'ACTIVE') return true;
  if (sub.status === 'CANCELED' && sub.currentPeriodEnd && sub.currentPeriodEnd > now) return true;
  return false;
}
```

- [ ] **Step 4: Implement the grant**

Append immediately after:

```ts
/**
 * Give a user PRO at no charge.
 *
 * Deliberately does NOT reuse upgradeSubscription(): that stamps a one-month
 * currentPeriodEnd and is the payment path. A comp has no period end at all,
 * which is what keeps expireSubscriptions() away from it even if the explicit
 * compedBy guard is ever removed.
 */
export async function grantCompedSubscription(
  userId: number,
  adminId: number,
  reason?: string
): Promise<CompGrantResult> {
  const now = new Date();

  // Read directly rather than through getOrCreateSubscription(), which would
  // write a TRIALING row for a brand-new user and then trip the check below
  // against itself.
  const existing = await prisma.subscription.findUnique({ where: { userId } });

  if (existing?.compedBy != null) {
    return { ok: false, code: 'ALREADY_COMPED' };
  }
  if (existing && hasPaidAccess(existing, now)) {
    return { ok: false, code: 'ALREADY_ACTIVE', plan: existing.plan, status: existing.status };
  }

  const compFields = {
    plan: 'PRO' as SubscriptionPlan,
    status: 'ACTIVE' as SubscriptionStatus,
    currentPeriodStart: now,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    compedBy: adminId,
    compedAt: now,
    compReason: reason ?? null,
  };

  const subscription = existing
    ? await prisma.subscription.update({ where: { userId }, data: compFields })
    : await prisma.subscription.create({
        // trialEndsAt has no default in the schema and must be supplied. There is
        // no trial to give — this user is going straight to PRO.
        data: { userId, trialStartedAt: now, trialEndsAt: now, ...compFields },
      });

  // Match upgradeSubscription: a new period starts with a clean slate.
  await prisma.usageCounter.upsert({
    where: { userId },
    update: {
      textSummariesUsed: 0,
      voiceSummariesUsed: 0,
      voiceEventsCreated: 0,
      remindersTriggered: 0,
      cycleStartDate: now,
    },
    create: { userId, cycleStartDate: now },
  });

  await trackActivity(userId, 'admin_granted_premium', {
    admin_id: adminId,
    reason: reason ?? null,
    to_plan: 'PRO',
  });

  await invalidateFeatureAccessCache(userId);

  console.log(`[Subscription] Admin ${adminId} comped PRO for user ${userId}${reason ? ` (${reason})` : ''}`);

  return { ok: true, subscription };
}
```

- [ ] **Step 5: Implement the revoke**

Append immediately after:

```ts
/**
 * Take a comped PRO back.
 *
 * Refuses anything that is not a comp, so a real paying customer can never be
 * downgraded through this path.
 */
export async function revokeCompedSubscription(
  userId: number,
  adminId: number
): Promise<CompRevokeResult> {
  const existing = await prisma.subscription.findUnique({ where: { userId } });

  if (!existing || existing.compedBy == null) {
    return { ok: false, code: 'NOT_COMPED' };
  }

  await prisma.subscription.update({
    where: { userId },
    data: {
      plan: 'FREE',
      status: 'EXPIRED',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      compedBy: null,
      compedAt: null,
      compReason: null,
    },
  });

  // Usage counters are deliberately left alone. They were zeroed at grant time,
  // and zeroing them again would hand a revoked user a fresh free quota.

  await trackActivity(userId, 'admin_revoked_premium', { admin_id: adminId });

  await invalidateFeatureAccessCache(userId);

  console.log(`[Subscription] Admin ${adminId} revoked comped PRO for user ${userId}`);

  return { ok: true };
}
```

- [ ] **Step 6: Verify it compiles**

Run: `npm run type-check`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/services/subscription-service.ts src/services/analytics-service.ts
git commit -m "feat(subscription): add comped grant/revoke with paid-access guard"
```

---

### Task 3: Make revocation take effect immediately

Three existing defects mean a revoked user keeps access for up to 24h on the cached result. Revocation is worthless without these.

**Files:**
- Modify: `app/api/admin/user-overrides/route.ts` (POST remove-override branch, ~line 432; DELETE handler, ~line 531)
- Modify: `src/services/subscription-reminders.ts` (`expireSubscriptions`, ~lines 234-283)

**Interfaces:**
- Consumes: `invalidateFeatureAccessCache` (already imported in the route); `Subscription.compedBy` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Invalidate on the POST remove-override branch**

In `app/api/admin/user-overrides/route.ts`, in the `if (!hasAnyOverride)` block, insert between the `deleteMany` and the `console.log`:

```ts
      // Without this the user keeps granted access for up to 24h on the cached
      // feature-access result.
      await invalidateFeatureAccessCache(user_id);
```

- [ ] **Step 2: Invalidate in the DELETE handler**

In the same file's `DELETE` handler, insert between the `if (result.count === 0)` block and its `console.log`:

```ts
    await invalidateFeatureAccessCache(userId);
```

- [ ] **Step 3: Stop the cron from expiring comps**

In `src/services/subscription-reminders.ts`, in `expireSubscriptions`, add one line to the `where` clause of `prisma.subscription.findMany`, after `plan: { not: 'FREE' },`:

```ts
      // Comped subscriptions never expire — only an admin revoke ends them.
      compedBy: null,
```

- [ ] **Step 4: Invalidate after the cron downgrade**

In the same function, immediately after the `prisma.subscription.update` that sets `status: 'EXPIRED', plan: 'FREE'`:

```ts
    // The 24h feature-access cache would otherwise keep serving paid access
    // after the downgrade.
    await invalidateFeatureAccessCache(sub.userId);
```

Add the import at the top of the file if it is not already present:

```ts
import { invalidateFeatureAccessCache } from './subscription-service';
```

- [ ] **Step 5: Confirm comped users cannot receive renewal reminders**

Read `sendExpiringReminders` in the same file. It selects on `currentPeriodEnd` proximity; a comped row has `currentPeriodEnd = NULL` and therefore cannot match. Verify this by reading the `where` clause — if it can match a NULL period end, add `compedBy: null` there too.

Run: `grep -n "currentPeriodEnd" src/services/subscription-reminders.ts`
Expected: every `findMany` selecting on `currentPeriodEnd` uses a comparison (`gte`/`lte`/`lt`) that cannot match NULL. Record what you found in the commit message.

- [ ] **Step 6: Verify it compiles**

Run: `npm run type-check`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add app/api/admin/user-overrides/route.ts src/services/subscription-reminders.ts
git commit -m "fix(admin): invalidate feature-access cache on every revoke path"
```

---

### Task 4: Admin grant/revoke API route

**Files:**
- Create: `app/api/admin/subscription/route.ts`

**Interfaces:**
- Consumes: `grantCompedSubscription`, `revokeCompedSubscription`, `CompGrantResult`, `CompRevokeResult` from Task 2.
- Produces:
  - `POST /api/admin/subscription` — body `{ initData: string, user_id: number, reason?: string }` → `200 { success: true, subscription: { plan, status, compedAt, compReason } }` | `409 { error }` | `404 { error: 'User not found' }`
  - `DELETE /api/admin/subscription?initData=…&user_id=…` → `200 { success: true }` | `409 { error }`

- [ ] **Step 1: Write the route**

Create `app/api/admin/subscription/route.ts`:

```ts
/**
 * Admin Subscription API
 * POST: Grant a free ("comped") PRO subscription to a user
 * DELETE: Revoke a comped PRO subscription
 *
 * Only comps are writable here. A real paying customer can never be created or
 * downgraded through this route — the guards live in the service layer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { grantCompedSubscription, revokeCompedSubscription } from '@/src/services/subscription-service';

export const dynamic = 'force-dynamic';

// POST: Grant comped PRO
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { initData, user_id, reason } = body;

    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    if (!user_id || typeof user_id !== 'number') {
      return NextResponse.json(
        { error: 'user_id is required and must be a number' },
        { status: 400 }
      );
    }

    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return NextResponse.json(
        { error: 'reason must be a string' },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { id: user_id } });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const result = await grantCompedSubscription(user_id, auth.adminId!, reason || undefined);

    if (!result.ok) {
      const message =
        result.code === 'ALREADY_COMPED'
          ? 'This user already has a comped subscription'
          : `User already has an active plan (${result.plan} / ${result.status})`;
      return NextResponse.json({ error: message }, { status: 409 });
    }

    console.log(`[admin-subscription] Admin ${auth.adminId} comped PRO for user ${user_id}`);

    return NextResponse.json({
      success: true,
      subscription: {
        plan: result.subscription.plan,
        status: result.subscription.status,
        compedAt: result.subscription.compedAt ? result.subscription.compedAt.toISOString() : null,
        compReason: result.subscription.compReason,
      },
    });
  } catch (error) {
    captureError(error, 'admin-subscription-post', { api_route: '/api/admin/subscription' });
    return NextResponse.json({ error: 'Failed to grant subscription' }, { status: 500 });
  }
}

// DELETE: Revoke comped PRO
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const initData = searchParams.get('initData');
    const targetUserId = searchParams.get('user_id');

    const auth = await verifyAdminAccess(initData || undefined);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    if (!targetUserId) {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 });
    }

    const userId = parseInt(targetUserId, 10);
    if (isNaN(userId)) {
      return NextResponse.json({ error: 'Invalid user_id' }, { status: 400 });
    }

    const result = await revokeCompedSubscription(userId, auth.adminId!);

    if (!result.ok) {
      return NextResponse.json(
        { error: 'This user does not have a comped subscription' },
        { status: 409 }
      );
    }

    console.log(`[admin-subscription] Admin ${auth.adminId} revoked comped PRO for user ${userId}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    captureError(error, 'admin-subscription-delete', { api_route: '/api/admin/subscription' });
    return NextResponse.json({ error: 'Failed to revoke subscription' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify it compiles and builds**

Run: `npm run type-check && npm run build`
Expected: both exit 0, and the build output lists `ƒ /api/admin/subscription`.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/subscription/route.ts
git commit -m "feat(admin): add grant/revoke comped subscription route"
```

---

### Task 5: Surface comp state in the existing admin reads

The card and the list both need to know whether a user is comped, so the UI can show Revoke instead of Grant.

**Files:**
- Modify: `app/api/admin/user-overrides/route.ts` — `mapUserToResponse` (~lines 111-148) and the single-user GET response (~lines 244-249)

**Interfaces:**
- Consumes: `Subscription.compedBy/compedAt/compReason` from Task 1.
- Produces: `subscription.comped: boolean`, `subscription.compedAt: string | null`, `subscription.compReason: string | null` on the single-user GET; `subscription.comped: boolean` on each list row.

- [ ] **Step 1: Widen the `mapUserToResponse` parameter type**

In `mapUserToResponse`, change the `subscription` field of the parameter type to:

```ts
  subscription: { plan: string; status: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null; compedBy: number | null } | null;
```

- [ ] **Step 2: Return `comped` on list rows**

In the same function's returned `subscription` object, after `currentPeriodEnd`:

```ts
      comped: user.subscription.compedBy != null,
```

- [ ] **Step 3: Return the full comp state on the single-user GET**

In the single-user GET response, in the `subscription: user.subscription ? { … } : null` object, after `currentPeriodEnd: user.subscription.currentPeriodEnd,`:

```ts
            comped: user.subscription.compedBy != null,
            compedAt: user.subscription.compedAt ? user.subscription.compedAt.toISOString() : null,
            compReason: user.subscription.compReason,
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run type-check`
Expected: exits 0. If `mapUserToResponse` reports a missing `compedBy`, the caller's Prisma `include` already selects the whole `subscription` relation, so no query change is needed — re-read the error before changing the query.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/user-overrides/route.ts
git commit -m "feat(admin): expose comped state on user list and detail responses"
```

---

### Task 6: i18n keys

**Files:**
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `admin.comp.*` (11 keys) and `admin.activity.userTitle`, consumed by Tasks 7 and 8.

- [ ] **Step 1: Add `admin.activity.userTitle` to all three files**

Inside the existing `admin.activity` object:

- `en.json`: `"userTitle": "Recent activity"`
- `he.json`: `"userTitle": "פעילות אחרונה"`
- `ru.json`: `"userTitle": "Последняя активность"`

- [ ] **Step 2: Add the `admin.comp` group to all three files**

Insert a new `"comp"` object inside `admin`, positioned between `"overrides"` and `"openDashboard"` so all three files keep identical key order.

`en.json`:

```json
    "comp": {
      "title": "Comped Premium",
      "description": "Give this user PRO access at no charge.",
      "grant": "Grant PRO",
      "granting": "Granting...",
      "revoke": "Revoke PRO",
      "revoking": "Revoking...",
      "activeSince": "Comped PRO since {date}",
      "reasonPlaceholder": "Why? (optional)",
      "blockedActive": "This user already has an active plan - nothing to comp.",
      "earlyAdoptionWarning": "Early-adoption mode is on for everyone, so this user already has full access. Granting won't change anything visible until you turn it off.",
      "failed": "Couldn't update premium access. Try again."
    },
```

`he.json`:

```json
    "comp": {
      "title": "פרימיום במתנה",
      "description": "לתת למשתמש הזה גישת PRO בלי תשלום.",
      "grant": "תן PRO",
      "granting": "נותן...",
      "revoke": "בטל PRO",
      "revoking": "מבטל...",
      "activeSince": "PRO במתנה מאז {date}",
      "reasonPlaceholder": "למה? (לא חובה)",
      "blockedActive": "למשתמש הזה כבר יש מנוי פעיל - אין מה לתת.",
      "earlyAdoptionWarning": "מצב מאמצים מוקדמים פעיל לכולם, אז למשתמש הזה כבר יש גישה מלאה. המתנה לא תשנה כלום עד שתכבה אותו.",
      "failed": "לא הצלחתי לעדכן את גישת הפרימיום. נסה שוב."
    },
```

`ru.json`:

```json
    "comp": {
      "title": "Премиум в подарок",
      "description": "Выдать этому пользователю доступ PRO бесплатно.",
      "grant": "Выдать PRO",
      "granting": "Выдаю...",
      "revoke": "Забрать PRO",
      "revoking": "Забираю...",
      "activeSince": "PRO в подарок с {date}",
      "reasonPlaceholder": "Причина (необязательно)",
      "blockedActive": "У пользователя уже есть активный план - дарить нечего.",
      "earlyAdoptionWarning": "Режим ранних пользователей включён для всех, так что доступ уже открыт. Подарок ничего не изменит, пока вы его не выключите.",
      "failed": "Не удалось изменить премиум-доступ. Попробуйте ещё раз."
    },
```

- [ ] **Step 3: Verify all three files still parse and have identical key structure**

Run:

```bash
for f in en he ru; do jq -r 'paths(scalars)|join(".")' messages/$f.json | sort > /tmp/keys-$f.txt; done
diff /tmp/keys-en.txt /tmp/keys-he.txt && diff /tmp/keys-en.txt /tmp/keys-ru.txt && echo "ALL THREE LOCALES IN SYNC"
```

Expected: prints `ALL THREE LOCALES IN SYNC` with no diff output.

- [ ] **Step 4: Commit**

```bash
git add messages/en.json messages/he.json messages/ru.json
git commit -m "feat(i18n): add comped-premium and per-user activity strings"
```

---

### Task 7: Per-user activity timeline in the card

**Files:**
- Modify: `app/[locale]/admin-panel/AdminPanelClient.tsx` — `UserOverrideDetails` interface (~line 51), state block (~line 205), `loadUserDetails` (~line 506), card JSX (insert before the Moderation section, ~line 2721), styles block (~line 1685)

**Interfaces:**
- Consumes: `admin.activity.userTitle` from Task 6; the existing `ActivityItem` interface (~line 112); the existing `formatRelativeTime` helper (~line 464); `GET /api/admin/user-activity?user_id=`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add isolated state for the card's timeline**

In the "User activity state" block, after `const [activityOffset, setActivityOffset] = useState(0);`:

```ts
  // Per-user activity shown inside the selected-user card. Deliberately separate
  // from the global activity state above — sharing it would empty the global
  // list whenever a user was selected.
  const [userActivity, setUserActivity] = useState<ActivityItem[]>([]);
  const [isLoadingUserActivity, setIsLoadingUserActivity] = useState(false);
  const [userActivityOffset, setUserActivityOffset] = useState(0);
  const [userActivityHasMore, setUserActivityHasMore] = useState(false);
```

- [ ] **Step 2: Add the fetcher**

Immediately after the existing `fetchActivity` `useCallback`:

```ts
  // Fetch one user's activity for the selected-user card
  const fetchUserActivity = useCallback(async (userId: number, reset: boolean = false) => {
    setIsLoadingUserActivity(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const newOffset = reset ? 0 : userActivityOffset;
      const params = new URLSearchParams({
        initData: initData || '',
        user_id: String(userId),
        limit: '20',
        offset: String(newOffset),
      });

      const response = await fetch(`/api/admin/user-activity?${params}`);
      const data = await response.json();
      if (data.success) {
        setUserActivity(prev => (reset ? (data.activities || []) : [...prev, ...(data.activities || [])]));
        setUserActivityOffset(newOffset + 20);
        setUserActivityHasMore(data.pagination?.hasMore || false);
      }
    } catch (error) {
      console.error('Failed to fetch user activity:', error);
    } finally {
      setIsLoadingUserActivity(false);
    }
  }, [userActivityOffset]);
```

- [ ] **Step 3: Load the timeline with the card**

In `loadUserDetails`, inside `if (data.success && data.user) {`, after `setOverrideReason(data.user.override?.reason || '');`:

```ts
        setUserActivity([]);
        setUserActivityOffset(0);
        void fetchUserActivity(userId, true);
```

- [ ] **Step 4: Clear it when the card closes**

In `clearSelectedUser`, after `setReminderFeedback(null);`:

```ts
    setUserActivity([]);
    setUserActivityOffset(0);
    setUserActivityHasMore(false);
```

- [ ] **Step 5: Render the timeline section**

In the card JSX, immediately before the `{/* Moderation Section (suspend / hard delete / ban) */}` comment:

```tsx
                {/* Recent activity for this user */}
                <div className="user-card-section">
                  <div className="user-card-section-title">{t('activity.userTitle')}</div>
                  {isLoadingUserActivity && userActivity.length === 0 ? (
                    <div className="empty-state">
                      <Loader2 size={20} className="animate-spin" style={{ margin: '0 auto' }} />
                    </div>
                  ) : userActivity.length === 0 ? (
                    <div className="empty-state">{t('activity.noActivity')}</div>
                  ) : (
                    <>
                      {userActivity.map((item) => (
                        <div key={item.id} className="user-activity-row">
                          <div className="user-activity-main">
                            <span className="activity-action-badge">{item.action}</span>
                            {item.metadata && Object.keys(item.metadata).length > 0 && (
                              <span className="user-activity-meta">
                                {JSON.stringify(item.metadata).substring(0, 60)}
                                {JSON.stringify(item.metadata).length > 60 && '...'}
                              </span>
                            )}
                          </div>
                          <div className="activity-time">{formatRelativeTime(item.createdAt)}</div>
                        </div>
                      ))}
                      {userActivityHasMore && (
                        <button
                          className="user-activity-more"
                          onClick={() => selectedUser && fetchUserActivity(selectedUser.id)}
                          disabled={isLoadingUserActivity}
                        >
                          {isLoadingUserActivity ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            t('activity.loadMore')
                          )}
                        </button>
                      )}
                    </>
                  )}
                </div>
```

Note `t('activity.loadMore')` already exists in all three locales and has had zero call sites until now.

- [ ] **Step 6: Add the three new styles**

In the `<style jsx>` block, immediately after the `.activity-time { … }` rule:

```css
        .user-activity-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 8px;
          padding: 6px 0;
          border-bottom: 1px solid #f3f4f6;
        }
        .user-activity-row:last-of-type {
          border-bottom: none;
        }
        .user-activity-main {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        .user-activity-meta {
          font-size: 11px;
          color: #9ca3af;
          word-break: break-all;
        }
        .user-activity-more {
          width: 100%;
          margin-top: 8px;
          padding: 8px;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: #fff;
          color: #4b5563;
          font-size: 13px;
          cursor: pointer;
        }
        .user-activity-more:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
```

- [ ] **Step 7: Verify**

Run: `npm run type-check`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add "app/[locale]/admin-panel/AdminPanelClient.tsx"
git commit -m "feat(admin): show a user's recent activity in their detail card"
```

---

### Task 8: Comped premium block in the card

**Files:**
- Modify: `app/[locale]/admin-panel/AdminPanelClient.tsx` — `UserOverrideDetails.subscription` (~line 61), state block, new handler after `saveOverride` (~line 565), card JSX before the activity section from Task 7, styles block

**Interfaces:**
- Consumes: `admin.comp.*` from Task 6; `POST`/`DELETE /api/admin/subscription` from Task 4; `subscription.comped/compedAt/compReason` from Task 5; the existing `earlyAdoptionMode` prop (already in `AdminPanelClientProps`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Widen the client-side subscription type**

In the `UserOverrideDetails` interface, in the `subscription` object type, after `currentPeriodEnd: string | null;`:

```ts
    comped: boolean;
    compedAt: string | null;
    compReason: string | null;
```

- [ ] **Step 2: Add state**

After the override state block:

```ts
  // Comped premium (admin-granted PRO)
  const [compReason, setCompReason] = useState('');
  const [isSavingComp, setIsSavingComp] = useState(false);
  const [compError, setCompError] = useState<string | null>(null);
```

- [ ] **Step 3: Seed and clear the reason alongside the card**

In `loadUserDetails`, after `setOverrideReason(...)`:

```ts
        setCompReason(data.user.subscription?.compReason || '');
        setCompError(null);
```

In `clearSelectedUser`, alongside the Task 7 resets:

```ts
    setCompReason('');
    setCompError(null);
```

- [ ] **Step 4: Add the grant/revoke handler**

Immediately after `saveOverride`:

```ts
  // Grant or revoke a comped PRO subscription
  const toggleComp = async (grant: boolean) => {
    if (!selectedUser) return;
    setIsSavingComp(true);
    setCompError(null);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = grant
        ? await fetch('/api/admin/subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData, user_id: selectedUser.id, reason: compReason || null }),
          })
        : await fetch(
            `/api/admin/subscription?initData=${encodeURIComponent(initData || '')}&user_id=${selectedUser.id}`,
            { method: 'DELETE' }
          );

      const data = await response.json();
      if (data.success) {
        await loadUserDetails(selectedUser.id);
        await fetchUserList();
      } else {
        setCompError(data.error || t('comp.failed'));
      }
    } catch (error) {
      console.error('Failed to update comped subscription:', error);
      setCompError(t('comp.failed'));
    } finally {
      setIsSavingComp(false);
    }
  };
```

- [ ] **Step 5: Render the block**

In the card JSX, immediately before the `{/* Recent activity for this user */}` comment added in Task 7:

```tsx
                {/* Comped premium */}
                <div className="user-card-section">
                  <div className="user-card-section-title">{t('comp.title')}</div>

                  {earlyAdoptionMode && (
                    <div className="comp-warning">{t('comp.earlyAdoptionWarning')}</div>
                  )}

                  {selectedUser.subscription?.comped ? (
                    <>
                      <p className="comp-description">
                        {selectedUser.subscription.compedAt
                          ? t('comp.activeSince').replace(
                              '{date}',
                              new Date(selectedUser.subscription.compedAt).toLocaleDateString(intlLocale, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })
                            )
                          : t('comp.title')}
                      </p>
                      {selectedUser.subscription.compReason && (
                        <p className="comp-description">{selectedUser.subscription.compReason}</p>
                      )}
                      <button className="comp-btn revoke" onClick={() => toggleComp(false)} disabled={isSavingComp}>
                        {isSavingComp ? (
                          <>
                            <Loader2 size={16} className="animate-spin" />
                            {t('comp.revoking')}
                          </>
                        ) : (
                          t('comp.revoke')
                        )}
                      </button>
                    </>
                  ) : selectedUser.subscription &&
                    (selectedUser.subscription.status === 'TRIALING' ||
                      selectedUser.subscription.status === 'ACTIVE') ? (
                    <p className="comp-description">{t('comp.blockedActive')}</p>
                  ) : (
                    <>
                      <p className="comp-description">{t('comp.description')}</p>
                      <input
                        type="text"
                        className="reason-input"
                        placeholder={t('comp.reasonPlaceholder')}
                        value={compReason}
                        onChange={(e) => setCompReason(e.target.value)}
                      />
                      <button className="comp-btn grant" onClick={() => toggleComp(true)} disabled={isSavingComp}>
                        {isSavingComp ? (
                          <>
                            <Loader2 size={16} className="animate-spin" />
                            {t('comp.granting')}
                          </>
                        ) : (
                          t('comp.grant')
                        )}
                      </button>
                    </>
                  )}

                  {compError && <div className="comp-error">{compError}</div>}
                </div>
```

- [ ] **Step 6: Add the styles**

In the `<style jsx>` block, after the styles added in Task 7:

```css
        .comp-description {
          font-size: 13px;
          color: #6b7280;
          margin: 0 0 8px;
        }
        .comp-warning {
          background: #fef3c7;
          border: 1px solid #f59e0b;
          border-radius: 8px;
          padding: 10px;
          margin-bottom: 10px;
          font-size: 12px;
          color: #92400e;
        }
        .comp-error {
          margin-top: 8px;
          font-size: 12px;
          color: #b91c1c;
        }
        .comp-btn {
          width: 100%;
          margin-top: 8px;
          padding: 12px;
          border: none;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          cursor: pointer;
        }
        .comp-btn.grant {
          background: #10b981;
        }
        .comp-btn.revoke {
          background: #ef4444;
        }
        .comp-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
```

- [ ] **Step 7: Verify**

Run: `npm run type-check && npm run build`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add "app/[locale]/admin-panel/AdminPanelClient.tsx"
git commit -m "feat(admin): grant and revoke comped PRO from the user card"
```

---

### Task 9: End-to-end verification against the real database

**Files:**
- Create (throwaway, not committed): `scripts/tmp-verify-comp.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: evidence that grant → revoke → re-grant behaves, and that the guards actually refuse.

- [ ] **Step 1: Write the verification script**

Create `scripts/tmp-verify-comp.ts`:

```ts
/**
 * Throwaway verification for comped subscriptions. Not part of the build.
 * Exercises the service layer directly against the configured database.
 */
import { prisma } from '../src/utils/prisma';
import {
  grantCompedSubscription,
  revokeCompedSubscription,
} from '../src/services/subscription-service';

const ADMIN_ID = 0; // synthetic actor; grantedBy has no FK constraint

async function main() {
  const user = await prisma.user.findFirst({ orderBy: { id: 'asc' } });
  if (!user) throw new Error('no users in this database');
  console.log(`using user ${user.id} (${user.name})`);

  const before = await prisma.subscription.findUnique({ where: { userId: user.id } });
  console.log('before:', before && { plan: before.plan, status: before.status, compedBy: before.compedBy });

  const g1 = await grantCompedSubscription(user.id, ADMIN_ID, 'verification run');
  console.log('grant #1:', g1.ok ? { plan: g1.subscription.plan, status: g1.subscription.status, compedBy: g1.subscription.compedBy, periodEnd: g1.subscription.currentPeriodEnd } : g1);

  const g2 = await grantCompedSubscription(user.id, ADMIN_ID);
  console.log('grant #2 (expect ALREADY_COMPED):', g2);

  const r1 = await revokeCompedSubscription(user.id, ADMIN_ID);
  console.log('revoke #1 (expect ok):', r1);

  const r2 = await revokeCompedSubscription(user.id, ADMIN_ID);
  console.log('revoke #2 (expect NOT_COMPED):', r2);

  const after = await prisma.subscription.findUnique({ where: { userId: user.id } });
  console.log('after:', after && { plan: after.plan, status: after.status, compedBy: after.compedBy });

  const log = await prisma.userActivity.findMany({
    where: { userId: user.id, action: { in: ['admin_granted_premium', 'admin_revoked_premium'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log('activity rows written:', log.map(l => ({ action: l.action, metadata: l.metadata })));

  // Restore whatever was there before so the database is left as found.
  if (before) {
    await prisma.subscription.update({ where: { userId: user.id }, data: {
      plan: before.plan, status: before.status,
      currentPeriodStart: before.currentPeriodStart, currentPeriodEnd: before.currentPeriodEnd,
      cancelAtPeriodEnd: before.cancelAtPeriodEnd,
      compedBy: before.compedBy, compedAt: before.compedAt, compReason: before.compReason,
    }});
  } else {
    await prisma.subscription.deleteMany({ where: { userId: user.id } });
  }
  await prisma.userActivity.deleteMany({
    where: { userId: user.id, action: { in: ['admin_granted_premium', 'admin_revoked_premium'] } },
  });
  console.log('restored original state');

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
```

- [ ] **Step 2: Apply the migration to the target database, then run it**

Run: `npx prisma migrate deploy && npx tsx -r dotenv/config scripts/tmp-verify-comp.ts`

Expected output, in order: `grant #1` shows `plan: 'PRO', status: 'ACTIVE', compedBy: 0, periodEnd: null`; `grant #2` shows `{ ok: false, code: 'ALREADY_COMPED' }`; `revoke #1` shows `{ ok: true }`; `revoke #2` shows `{ ok: false, code: 'NOT_COMPED' }`; `after` shows `plan: 'FREE', status: 'EXPIRED', compedBy: null`; two activity rows appear; `restored original state` prints last.

If the database is unreachable, record that plainly and do not claim this step passed.

- [ ] **Step 3: Confirm the guard against overwriting paid access**

Temporarily set the test user to `status: 'TRIALING'` in the database, re-run only the grant, and confirm it returns `{ ok: false, code: 'ALREADY_ACTIVE', plan, status }` rather than writing. Restore afterwards.

- [ ] **Step 4: Delete the throwaway script**

Run: `rm scripts/tmp-verify-comp.ts`
It must not be committed.

- [ ] **Step 5: Full build**

Run: `npm run type-check && npm run build`
Expected: both exit 0.

- [ ] **Step 6: Confirm locale parity one final time**

Run:

```bash
for f in en he ru; do jq -r 'paths(scalars)|join(".")' messages/$f.json | sort > /tmp/keys-$f.txt; done
diff /tmp/keys-en.txt /tmp/keys-he.txt && diff /tmp/keys-en.txt /tmp/keys-ru.txt && echo "ALL THREE LOCALES IN SYNC"
```

Expected: `ALL THREE LOCALES IN SYNC`.

---

## Known limitations, to be stated when reporting completion

- A user who is `TRIALING` cannot be comped. New users trial for 14 days, so they must wait it out. This is by design — `effectivePlan` is already `PRO` during a trial, so a comp would change nothing — but it means "grant premium to anyone" has a waiting period.
- Only 22 of 38 declared `ActivityAction` values are ever written. Timelines will show nothing for messages received, commands run, webapp opens, settings changes, or calendar syncs; those exist only as Sentry breadcrumbs.
- The card's timeline has no action filter, because the endpoint's `actionStats` are computed with no `where` clause and are therefore global.
- A fresh database would fail the migration, since no migration ever creates `Subscription`. Pre-existing condition, not introduced here.
- `app/api/admin/analytics/route.ts:37-52` has an auth bypass (`if (initData && !verify(...))` skips verification when `initData` is absent). Same pattern at `app/api/subscription/upgrade/route.ts:55`. Out of scope, reported not fixed.
