-- Send a copy of an event (docs/superpowers/specs/2026-11-27-send-event-copy-design.md): one single-use offer per tap.
CREATE TABLE "EventCopyOffer" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "senderUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenAt" TIMESTAMP(3),
    "takenByUserId" INTEGER,
    "copyEventId" TEXT,

    CONSTRAINT "EventCopyOffer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventCopyOffer_tokenHash_key" ON "EventCopyOffer"("tokenHash");

CREATE INDEX "EventCopyOffer_senderUserId_idx" ON "EventCopyOffer"("senderUserId");

ALTER TABLE "EventCopyOffer" ADD CONSTRAINT "EventCopyOffer_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "NativeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventCopyOffer" ADD CONSTRAINT "EventCopyOffer_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventCopyOffer" ADD CONSTRAINT "EventCopyOffer_takenByUserId_fkey" FOREIGN KEY ("takenByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EventCopyOffer" ADD CONSTRAINT "EventCopyOffer_copyEventId_fkey" FOREIGN KEY ("copyEventId") REFERENCES "NativeEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
