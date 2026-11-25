-- The Birthday switch (docs/superpowers/specs/2026-11-25-birthday-switch-design.md): off on every existing event.
ALTER TABLE "NativeEvent" ADD COLUMN "birthday" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "birthYear" INTEGER;
