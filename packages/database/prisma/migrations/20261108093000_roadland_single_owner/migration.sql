-- 땅 한 칸에 주인 하나(거래가 있는 소유)로 바꾼다.
-- 차마다 따로 갖던 기존 소유는 한 칸에 여러 주인이 있을 수 있고 거래가도 없어 옮길 수 없으므로 비운다(아직 운영 데이터 없음).
DELETE FROM "owned_tiles";

-- AlterTable
ALTER TABLE "owned_tiles" DROP CONSTRAINT "owned_tiles_pkey",
ADD COLUMN     "price" INTEGER NOT NULL,
ADD CONSTRAINT "owned_tiles_pkey" PRIMARY KEY ("q", "r");

-- CreateTable
CREATE TABLE "tile_records" (
    "vehicle_id" TEXT NOT NULL,
    "q" INTEGER NOT NULL,
    "r" INTEGER NOT NULL,
    "good_trips" INTEGER NOT NULL DEFAULT 0,
    "bad_trips" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tile_records_pkey" PRIMARY KEY ("vehicle_id","q","r")
);

-- CreateIndex
CREATE INDEX "owned_tiles_vehicle_id_idx" ON "owned_tiles"("vehicle_id");

-- AddForeignKey
ALTER TABLE "tile_records" ADD CONSTRAINT "tile_records_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
