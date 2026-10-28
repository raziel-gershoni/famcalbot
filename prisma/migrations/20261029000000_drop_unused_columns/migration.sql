-- Drop the AdminSettings columns that held a model name, a thinking level, a TTS model and the
-- calendar-home rollout (all fixed in src/config/*; the rollout switch was set to ALL and removed),
-- the enum of that rollout, and the User columns for the old voice picker, the "location confirmed"
-- flag and the weekly-lookahead flag, none of which any code reads or writes. Step 2 of 2: the build
-- that stopped selecting them is live, so no serving build names them while this migration runs.
-- Idempotent: a re-run is a no-op. None of the columns is indexed.
ALTER TABLE "AdminSettings" DROP COLUMN IF EXISTS "defaultAiModel";
ALTER TABLE "AdminSettings" DROP COLUMN IF EXISTS "geminiThinkingLevel";
ALTER TABLE "AdminSettings" DROP COLUMN IF EXISTS "ttsModel";
ALTER TABLE "AdminSettings" DROP COLUMN IF EXISTS "calendarHomeRollout";
-- After the column: DROP TYPE fails while a column still uses the enum.
DROP TYPE IF EXISTS "CalendarHomeRollout";
ALTER TABLE "User" DROP COLUMN IF EXISTS "voicePreference";
ALTER TABLE "User" DROP COLUMN IF EXISTS "voiceStyle";
ALTER TABLE "User" DROP COLUMN IF EXISTS "locationForced";
ALTER TABLE "User" DROP COLUMN IF EXISTS "includeWeeklyInLookahead";
