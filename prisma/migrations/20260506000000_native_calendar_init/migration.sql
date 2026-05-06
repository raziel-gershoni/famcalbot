-- Native calendar + pairing initial schema (additive only).
-- Adds enums, new tables, and nullable User columns. Existing GCal flows untouched.
-- The follow-up migration `20260506000001_user_calendar_source_backfill` backfills
-- User.calendarSource based on googleRefreshToken and tightens nullability.

-- Enums
CREATE TYPE "CalendarSource" AS ENUM ('GOOGLE', 'NATIVE');
CREATE TYPE "NativeCalendarPrivacy" AS ENUM ('PRIVATE', 'SHARED_VIEWER', 'SHARED_EDITOR');
CREATE TYPE "PairingStatus" AS ENUM ('PENDING', 'ACTIVE', 'UNLINKED');
CREATE TYPE "NativeEventInstanceStatus" AS ENUM ('OVERRIDE', 'CANCELLED');

-- User: add calendarSource (nullable; backfilled in next migration so existing GCal users are
-- correctly classified — adding with DEFAULT 'NATIVE' would silently mislabel them).
ALTER TABLE "User" ADD COLUMN "calendarSource" "CalendarSource";
ALTER TABLE "User" ADD COLUMN "pairingId" TEXT;

CREATE INDEX "User_calendarSource_idx" ON "User"("calendarSource");
CREATE INDEX "User_pairingId_idx" ON "User"("pairingId");

-- NativeCalendar
CREATE TABLE "NativeCalendar" (
    "id" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#039BE5',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "personName" TEXT,
    "personEnglishName" TEXT,
    "personGender" TEXT,
    "rules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "privacy" "NativeCalendarPrivacy" NOT NULL DEFAULT 'PRIVATE',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeCalendar_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NativeCalendar_ownerUserId_idx" ON "NativeCalendar"("ownerUserId");
CREATE INDEX "NativeCalendar_ownerUserId_privacy_idx" ON "NativeCalendar"("ownerUserId", "privacy");
CREATE INDEX "NativeCalendar_ownerUserId_isDeleted_idx" ON "NativeCalendar"("ownerUserId", "isDeleted");

-- NativeEvent (series row, or single event when rrule IS NULL)
CREATE TABLE "NativeEvent" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "creatorUserId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL,
    "rrule" TEXT,
    "exdates" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "reminderMinutes" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NativeEvent_calendarId_startsAt_idx" ON "NativeEvent"("calendarId", "startsAt");
CREATE INDEX "NativeEvent_calendarId_isDeleted_idx" ON "NativeEvent"("calendarId", "isDeleted");
CREATE INDEX "NativeEvent_creatorUserId_idx" ON "NativeEvent"("creatorUserId");

-- NativeEventInstance (per-occurrence override of a recurring series)
CREATE TABLE "NativeEventInstance" (
    "id" TEXT NOT NULL,
    "seriesEventId" TEXT NOT NULL,
    "originalStartsAt" TIMESTAMP(3) NOT NULL,
    "status" "NativeEventInstanceStatus" NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "location" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "allDay" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeEventInstance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NativeEventInstance_seriesEventId_originalStartsAt_key" ON "NativeEventInstance"("seriesEventId", "originalStartsAt");
CREATE INDEX "NativeEventInstance_seriesEventId_originalStartsAt_idx" ON "NativeEventInstance"("seriesEventId", "originalStartsAt");

-- Pairing
CREATE TABLE "Pairing" (
    "id" TEXT NOT NULL,
    "status" "PairingStatus" NOT NULL,
    "inviterUserId" INTEGER NOT NULL,
    "inviteeUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "unlinkedAt" TIMESTAMP(3),
    "unlinkedByUserId" INTEGER,

    CONSTRAINT "Pairing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Pairing_inviterUserId_idx" ON "Pairing"("inviterUserId");
CREATE INDEX "Pairing_inviteeUserId_idx" ON "Pairing"("inviteeUserId");
CREATE INDEX "Pairing_status_idx" ON "Pairing"("status");

-- PairingInvite (DB-backed, 7-day TTL, rendered in miniapp; not Redis)
CREATE TABLE "PairingInvite" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "inviterUserId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" INTEGER,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PairingInvite_token_key" ON "PairingInvite"("token");
CREATE INDEX "PairingInvite_token_idx" ON "PairingInvite"("token");
CREATE INDEX "PairingInvite_inviterUserId_idx" ON "PairingInvite"("inviterUserId");
CREATE INDEX "PairingInvite_expiresAt_idx" ON "PairingInvite"("expiresAt");

-- Foreign keys
ALTER TABLE "User" ADD CONSTRAINT "User_pairingId_fkey"
    FOREIGN KEY ("pairingId") REFERENCES "Pairing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "NativeCalendar" ADD CONSTRAINT "NativeCalendar_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NativeEvent" ADD CONSTRAINT "NativeEvent_calendarId_fkey"
    FOREIGN KEY ("calendarId") REFERENCES "NativeCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeEvent" ADD CONSTRAINT "NativeEvent_creatorUserId_fkey"
    FOREIGN KEY ("creatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NativeEventInstance" ADD CONSTRAINT "NativeEventInstance_seriesEventId_fkey"
    FOREIGN KEY ("seriesEventId") REFERENCES "NativeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_inviterUserId_fkey"
    FOREIGN KEY ("inviterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_inviteeUserId_fkey"
    FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PairingInvite" ADD CONSTRAINT "PairingInvite_inviterUserId_fkey"
    FOREIGN KEY ("inviterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PairingInvite" ADD CONSTRAINT "PairingInvite_acceptedByUserId_fkey"
    FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
