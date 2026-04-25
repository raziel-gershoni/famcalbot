-- Add suspension fields to User
ALTER TABLE "User" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "suspendedBy" INTEGER;
ALTER TABLE "User" ADD COLUMN "suspendedReason" TEXT;
CREATE INDEX "User_suspendedAt_idx" ON "User"("suspendedAt");

-- Persistent blocklist (survives hard-delete of User)
CREATE TABLE "BlockedIdentifier" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT,
    "whatsappPhone" TEXT,
    "bannedBy" INTEGER NOT NULL,
    "bannedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedIdentifier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BlockedIdentifier_telegramId_key" ON "BlockedIdentifier"("telegramId");
CREATE UNIQUE INDEX "BlockedIdentifier_whatsappPhone_key" ON "BlockedIdentifier"("whatsappPhone");
CREATE INDEX "BlockedIdentifier_telegramId_idx" ON "BlockedIdentifier"("telegramId");
CREATE INDEX "BlockedIdentifier_whatsappPhone_idx" ON "BlockedIdentifier"("whatsappPhone");
