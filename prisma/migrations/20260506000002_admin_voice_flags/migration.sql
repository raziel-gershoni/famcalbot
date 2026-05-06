-- Voice frictionlessness admin toggles. Both default false so the migration
-- is a no-op for existing behavior; admin flips them on from the panel after
-- first-week telemetry.

ALTER TABLE "AdminSettings"
  ADD COLUMN "voiceAutoCreateHighConf" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "voiceTtsOutcome" BOOLEAN NOT NULL DEFAULT false;
