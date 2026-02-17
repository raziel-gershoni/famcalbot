-- AlterTable
ALTER TABLE "AdminSettings" ADD COLUMN "earlyAdoptionMode" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "UserFeatureOverride" ADD COLUMN "earlyAdopter" BOOLEAN NOT NULL DEFAULT false;
