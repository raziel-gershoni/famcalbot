-- Drop the five old ping columns of "NativeReminderState" and their index: each recipient's ping now
-- lives on "NativeReminderPing" (20261026000000_remind_us_both, which copied them). Step 2 of 2: the
-- build that stopped reading them (the claim's deploy-window fallback is gone) is live, so no serving
-- build reads or writes them while this migration runs.
DROP INDEX IF EXISTS "NativeReminderState_snoozedUntil_idx";
ALTER TABLE "NativeReminderState" DROP COLUMN IF EXISTS "snoozedUntil";
ALTER TABLE "NativeReminderState" DROP COLUMN IF EXISTS "lastPingedAt";
ALTER TABLE "NativeReminderState" DROP COLUMN IF EXISTS "pingAttempts";
ALTER TABLE "NativeReminderState" DROP COLUMN IF EXISTS "pingChatId";
ALTER TABLE "NativeReminderState" DROP COLUMN IF EXISTS "pingMessageId";
