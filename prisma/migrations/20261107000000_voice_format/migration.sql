-- The calm single voice (spec docs/superpowers/specs/2026-11-07-calm-voice-design.md §3, Technical choices).
--
-- "voiceFormat": how a person's summary voice notes sound: 'show' (the two-host radio show, everyone's default,
-- existing accounts included) or 'calm' (one calm presenter reading the same content). A closed set the settings
-- route enforces (isVoiceFormat, src/services/voice-show/types.ts); the voice code reads anything but 'calm' as the
-- show (voiceFormatOf).
--
-- An addition only, so one push is enough: the previous build, still serving while this runs, never reads it.
-- Hand-written and idempotent, like the other recent migrations: a re-run is a no-op.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "voiceFormat" TEXT NOT NULL DEFAULT 'show';
