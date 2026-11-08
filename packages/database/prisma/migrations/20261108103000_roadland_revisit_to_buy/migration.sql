-- 주인이 있는 땅은 마지막 거래 뒤에 다시 지나가야 살 수 있다.
-- 기존 땅은 이 마이그레이션 시각을 거래 시각으로 보고, 기존 기록에는 지나간 시각이 없으므로 모두 다시 지나가야 한다.

-- AlterTable
ALTER TABLE "owned_tiles" ADD COLUMN     "traded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "tile_records" ADD COLUMN     "last_passed_at" TIMESTAMP(3);
