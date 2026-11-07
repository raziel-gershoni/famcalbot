-- The Jewish times API's keys (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5).
--
-- "ApiKey": the key of one of the owner's other apps. "keyHash" is the SHA-256 (hex) of the key, unique: the key itself is
-- never stored. "prefix" is its first 10 characters, for the admin panel's list. "origins" are the web origins a browser
-- may call from (empty: a server key). "createdBy" is the admin's User.id, with no foreign key (a key outlives its maker's
-- account, as BlockedIdentifier."bannedBy" does). "revokedAt" set: refused from then on. Read and written only by
-- src/services/api-keys/store.ts.
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never reads it. Hand-written
-- and idempotent, like the other recent migrations: each object is made only when missing, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" SERIAL NOT NULL,
    "appName" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" INTEGER NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
