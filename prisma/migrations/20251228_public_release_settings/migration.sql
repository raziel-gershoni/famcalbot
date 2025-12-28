-- Public Release Settings Migration
-- 1. Rename hebrewName → englishName (copy existing data)
-- 2. Rename spouseHebrewName → spouseEnglishName
-- 3. Make spouse fields nullable (deprecated)
-- 4. Add new user settings fields

-- Step 1: Add new columns with defaults
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "englishName" TEXT DEFAULT '';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "spouseEnglishName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "culture" TEXT DEFAULT 'default';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locationForced" BOOLEAN DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "globalRules" TEXT[] DEFAULT '{}';

-- Step 2: Copy data from old columns to new columns
UPDATE "User" SET "englishName" = "hebrewName" WHERE "englishName" = '' OR "englishName" IS NULL;
UPDATE "User" SET "spouseEnglishName" = "spouseHebrewName" WHERE "spouseEnglishName" IS NULL AND "spouseHebrewName" IS NOT NULL;

-- Step 3: Make spouse fields nullable
ALTER TABLE "User" ALTER COLUMN "spouseName" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "spouseGender" DROP NOT NULL;

-- Step 4: Drop old columns
ALTER TABLE "User" DROP COLUMN IF EXISTS "hebrewName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "spouseHebrewName";

-- Step 5: Make englishName required (now has data)
ALTER TABLE "User" ALTER COLUMN "englishName" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "englishName" DROP DEFAULT;
