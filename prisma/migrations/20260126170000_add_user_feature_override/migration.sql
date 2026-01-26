-- CreateTable
CREATE TABLE "UserFeatureOverride" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "unlimitedSummaries" BOOLEAN,
    "remindersEnabled" BOOLEAN,
    "voiceEventsEnabled" BOOLEAN,
    "unlimitedCalendars" BOOLEAN,
    "grantedBy" INTEGER,
    "grantedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFeatureOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserFeatureOverride_userId_key" ON "UserFeatureOverride"("userId");

-- CreateIndex
CREATE INDEX "UserFeatureOverride_userId_idx" ON "UserFeatureOverride"("userId");

-- AddForeignKey
ALTER TABLE "UserFeatureOverride" ADD CONSTRAINT "UserFeatureOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
