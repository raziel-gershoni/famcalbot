-- Admin-selectable text-to-speech model. NULL means "use GEMINI_TTS_MODEL, then the
-- code default". Hand-written and idempotent, matching the other recent migrations.

ALTER TABLE "AdminSettings" ADD COLUMN IF NOT EXISTS "ttsModel" TEXT;
