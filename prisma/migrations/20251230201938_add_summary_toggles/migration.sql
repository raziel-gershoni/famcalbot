/*
  Warnings:

  - Made the column `culture` on table `User` required. This step will fail if there are existing NULL values in that column.
  - Made the column `locationForced` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "textSummaryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "voiceSummaryEnabled" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "language" SET DEFAULT 'he',
ALTER COLUMN "englishName" SET DEFAULT '',
ALTER COLUMN "culture" SET NOT NULL,
ALTER COLUMN "locationForced" SET NOT NULL;
