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
