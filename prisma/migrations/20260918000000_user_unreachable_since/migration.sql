-- Track users Telegram refuses to deliver to (403: bot blocked / user deactivated /
-- bot kicked). Without this a blocked user is retried on every scheduled run forever,
-- failing three sends each time and paging an admin on the third.
--
-- Written by hand and made idempotent: the User table predates several migrations in
-- this directory, so a generated diff is not reliable here.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "unreachableSince" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_unreachableSince_idx" ON "User"("unreachableSince");
