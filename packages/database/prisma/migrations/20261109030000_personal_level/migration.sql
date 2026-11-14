ALTER TABLE "vehicles" ADD COLUMN "personal_level" INTEGER NOT NULL DEFAULT 1;
UPDATE "vehicles" v SET "personal_level" = LEAST(60, GREATEST(1, COALESCE((SELECT MAX(o.level) FROM "owned_tiles" o WHERE o.vehicle_id = v.id), 1)));
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_personal_level_check" CHECK ("personal_level" BETWEEN 1 AND 60);
