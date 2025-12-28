-- Remove Legacy Spouse Fields Migration
-- Spouse info is now stored in calendar assignments (personName, personEnglishName, personGender)

-- Drop deprecated spouse columns
ALTER TABLE "User" DROP COLUMN IF EXISTS "spouseName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "spouseEnglishName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "spouseGender";

-- Update location default to empty string (users should set their own location)
ALTER TABLE "User" ALTER COLUMN "location" SET DEFAULT '';
