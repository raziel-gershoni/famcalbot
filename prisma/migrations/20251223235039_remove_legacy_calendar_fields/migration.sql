/*
  Warnings:

  - You are about to drop the column `calendars` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `ownCalendars` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `primaryCalendar` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `spouseCalendars` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "calendars",
DROP COLUMN "ownCalendars",
DROP COLUMN "primaryCalendar",
DROP COLUMN "spouseCalendars";
