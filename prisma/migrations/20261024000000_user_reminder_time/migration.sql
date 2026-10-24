-- The local time a user's date-only reminders ping at (HH:mm, 15-minute step); NULL = 09:00.
ALTER TABLE "User" ADD COLUMN "reminderTime" TEXT;
