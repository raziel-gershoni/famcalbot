-- AlterTable
ALTER TABLE "User" ADD COLUMN "whatsappBsuid" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_whatsappBsuid_key" ON "User"("whatsappBsuid");

-- CreateIndex
CREATE INDEX "User_whatsappBsuid_idx" ON "User"("whatsappBsuid");
