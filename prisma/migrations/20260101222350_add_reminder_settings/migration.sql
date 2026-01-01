-- AlterTable
ALTER TABLE "User" ADD COLUMN     "defaultReminderMinutes" INTEGER,
ADD COLUMN     "remindersEnabled" BOOLEAN NOT NULL DEFAULT false;
