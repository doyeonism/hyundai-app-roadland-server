-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "safe_streak" INTEGER NOT NULL DEFAULT 0,
    "best_safe_streak" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_trips" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "client_trip_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "day" TEXT NOT NULL,
    "km" DOUBLE PRECISION NOT NULL,
    "safety_score" INTEGER NOT NULL,
    "hard_brakes" INTEGER NOT NULL,
    "warnings" INTEGER NOT NULL,
    "lane_changes" INTEGER NOT NULL,
    "signaled_lane_changes" INTEGER NOT NULL,
    "tiles" JSONB NOT NULL,
    "new_tiles" INTEGER NOT NULL,
    "credits" INTEGER NOT NULL,
    "clean" INTEGER NOT NULL,
    "assist_bonus" INTEGER NOT NULL,
    "manner_bonus" INTEGER NOT NULL,
    "excluded" INTEGER NOT NULL,
    "cap_reached" BOOLEAN NOT NULL,
    "rejected" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tile_visits" (
    "vehicle_id" TEXT NOT NULL,
    "q" INTEGER NOT NULL,
    "r" INTEGER NOT NULL,
    "day" TEXT NOT NULL,

    CONSTRAINT "tile_visits_pkey" PRIMARY KEY ("vehicle_id","q","r","day")
);

-- CreateTable
CREATE TABLE "owned_tiles" (
    "vehicle_id" TEXT NOT NULL,
    "q" INTEGER NOT NULL,
    "r" INTEGER NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "collected_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owned_tiles_pkey" PRIMARY KEY ("vehicle_id","q","r")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_token_hash_key" ON "vehicles"("token_hash");

-- CreateIndex
CREATE INDEX "vehicle_trips_vehicle_id_day_idx" ON "vehicle_trips"("vehicle_id", "day");

-- CreateIndex
CREATE INDEX "vehicle_trips_vehicle_id_ended_at_idx" ON "vehicle_trips"("vehicle_id", "ended_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_trips_vehicle_id_client_trip_id_key" ON "vehicle_trips"("vehicle_id", "client_trip_id");

-- CreateIndex
CREATE INDEX "tile_visits_vehicle_id_day_idx" ON "tile_visits"("vehicle_id", "day");

-- CreateIndex
CREATE INDEX "credit_ledger_vehicle_id_created_at_idx" ON "credit_ledger"("vehicle_id", "created_at");

-- AddForeignKey
ALTER TABLE "vehicle_trips" ADD CONSTRAINT "vehicle_trips_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tile_visits" ADD CONSTRAINT "tile_visits_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owned_tiles" ADD CONSTRAINT "owned_tiles_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
