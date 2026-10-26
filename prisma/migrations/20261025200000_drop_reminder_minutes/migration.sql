-- Drop NativeEvent.reminderMinutes, replaced by ownAlerts/alertMinutes (20261025000000_event_alerts,
-- which copied its data). Step 2 of 2: the build that stopped selecting the column (b061d59) is live,
-- so no serving build reads it while this migration runs.
ALTER TABLE "NativeEvent" DROP COLUMN IF EXISTS "reminderMinutes";
