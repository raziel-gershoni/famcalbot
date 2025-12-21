-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT,
    "whatsappPhone" TEXT,
    "name" TEXT NOT NULL,
    "hebrewName" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "spouseName" TEXT NOT NULL,
    "spouseHebrewName" TEXT NOT NULL,
    "spouseGender" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT 'Harish, Israel',
    "language" TEXT NOT NULL DEFAULT 'Hebrew',
    "messagingPlatform" TEXT NOT NULL DEFAULT 'telegram',
    "googleRefreshToken" TEXT NOT NULL,
    "calendars" TEXT[],
    "primaryCalendar" TEXT NOT NULL,
    "ownCalendars" TEXT[],
    "spouseCalendars" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "User_whatsappPhone_key" ON "User"("whatsappPhone");

-- CreateIndex
CREATE INDEX "User_telegramId_idx" ON "User"("telegramId");

-- CreateIndex
CREATE INDEX "User_whatsappPhone_idx" ON "User"("whatsappPhone");
