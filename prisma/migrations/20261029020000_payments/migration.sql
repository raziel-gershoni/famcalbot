-- One row per Telegram Stars payment (the final review's I-1; the lawyer's to-do 4(h)). The Privacy Policy keeps the
-- reference number and the month of each payment, and the Terms refund any payment within 14 days of it, so a renewal
-- or an upgrade must not overwrite the one before (Subscription.telegramPaymentChargeId holds only the last).
--
-- The credit writes its row first, in its own transaction: the unique charge id is what makes a second delivery of the
-- same successful_payment credit nothing, even after a refund. "Subscription"."telegramPaymentChargeId" stays as it is
-- (the last charge: it tells which payment funds the current month); nothing is dropped.
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never reads or writes the
-- table. Hand-written and idempotent, like the other recent migrations: the table, its indexes and its key are created
-- only when missing, and the copy skips a charge that already has its row, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "Payment" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "telegramPaymentChargeId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- The unique key is also the ON CONFLICT target of the copy below and of the credit's insert.
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_telegramPaymentChargeId_key" ON "Payment"("telegramPaymentChargeId");
CREATE INDEX IF NOT EXISTS "Payment_userId_idx" ON "Payment"("userId");

-- Deleted with the account: the Policy's deletion keeps no payment records of ours (Telegram keeps its own).
DO $$ BEGIN
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- The payments made before this table: each subscription keeps its last charge id with the month it paid for (its
-- current period, which every payment sets). One row per such charge:
--   - the period: the subscription's currentPeriodStart (the moment it was paid) and currentPeriodEnd;
--   - the plan: the subscription's plan; for a month that has lapsed since (the expiry run sets plan FREE and keeps the
--     charge id), the plan the activity log recorded for it, at the payment ("subscription_upgraded", to_plan) or at its
--     expiry ("subscription_expired", plan), within the period;
--   - the amount: nothing stored it, so the plan's price on the day it was paid (src/config/plans.ts's history: 150/300
--     Stars until 2026-04-06 21:51 UTC, 1500/2500 until 2026-09-17 14:08 UTC, 2500/5000 since; a payment's pre-checkout
--     accepts only the price of its day);
--   - the currency: XTR (Telegram Stars, the only one the bot takes).
-- Left out, with nothing to tell them by: a free Pro gift made after the payment (it rewrote the plan and the period),
-- a row whose period was cleared, and a lapsed month whose plan the log no longer has (it keeps 90 days). Their charge
-- ids stay on "Subscription" as before.
INSERT INTO "Payment" ("id", "userId", "telegramPaymentChargeId", "plan", "amount", "currency", "paidAt", "periodStart", "periodEnd")
SELECT gen_random_uuid()::text, p."userId", p."charge", p."plan"::"SubscriptionPlan",
       CASE
         WHEN p."paidAt" < TIMESTAMP '2026-04-06 21:51:08' THEN CASE p."plan" WHEN 'BASIC' THEN 150 ELSE 300 END
         WHEN p."paidAt" < TIMESTAMP '2026-09-17 14:08:33' THEN CASE p."plan" WHEN 'BASIC' THEN 1500 ELSE 2500 END
         ELSE CASE p."plan" WHEN 'BASIC' THEN 2500 ELSE 5000 END
       END,
       'XTR', p."paidAt", p."paidAt", p."periodEnd"
FROM (
  SELECT DISTINCT ON (s."telegramPaymentChargeId")
         s."userId",
         s."telegramPaymentChargeId" AS "charge",
         s."currentPeriodStart" AS "paidAt",
         s."currentPeriodEnd" AS "periodEnd",
         COALESCE(NULLIF(s."plan"::text, 'FREE'), (
           SELECT COALESCE(a."metadata"->>'to_plan', a."metadata"->>'plan')
           FROM "UserActivity" a
           WHERE a."userId" = s."userId"
             AND a."action" IN ('subscription_upgraded', 'subscription_expired')
             AND COALESCE(a."metadata"->>'to_plan', a."metadata"->>'plan') IN ('BASIC', 'PRO')
             AND a."createdAt" BETWEEN s."currentPeriodStart" - INTERVAL '1 hour' AND s."currentPeriodEnd" + INTERVAL '3 days'
           ORDER BY a."createdAt" DESC
           LIMIT 1
         )) AS "plan"
  FROM "Subscription" s
  WHERE s."telegramPaymentChargeId" IS NOT NULL
    AND s."compedBy" IS NULL
    AND s."currentPeriodStart" IS NOT NULL
    AND s."currentPeriodEnd" IS NOT NULL
  ORDER BY s."telegramPaymentChargeId", s."currentPeriodStart" DESC
) p
WHERE p."plan" IN ('BASIC', 'PRO')
ON CONFLICT ("telegramPaymentChargeId") DO NOTHING;
