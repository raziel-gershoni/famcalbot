-- The payments backfill of 20261029020000_payments, run once more after that release went live. While Railway built that
-- release, the build before it still served, and a payment it credited in those minutes set the subscription's charge id
-- without a "Payment" row (it never knew the table). This copies any such charge, exactly as the first backfill did; a
-- charge that already has its row (every payment the new build credited, and every one the first backfill copied) is
-- skipped by ON CONFLICT, so on a deploy with no payment in that window it inserts nothing. The rules, the dated prices
-- and the left-out cases are the first backfill's (see its comments).
--
-- Additions only, idempotent: a re-run is a no-op.

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
