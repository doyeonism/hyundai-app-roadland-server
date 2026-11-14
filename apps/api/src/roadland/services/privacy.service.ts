import { BadRequestException, Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { prisma } from "@roadland/database";
import { RedisService } from "../../shared/redis/redis.service";
import { vehicleTokenKey, landRankKey, vehicleClockKey } from "../../shared/redis/keys";
import { lockVehicles } from "./db-lock";
import { VehicleLockService } from "./vehicle-lock.service";
import { daysAgo, seoulDay } from "../domain/rules";

export const CONSENT_VERSION = "2026-11-14";
@Injectable()
export class PrivacyService {
  constructor(private readonly redis: RedisService, private readonly lock: VehicleLockService) {}

  async consent(vehicleId: string, version: string) {
    if (version !== CONSENT_VERSION) throw new BadRequestException("최신 데이터 이용 안내를 확인해 주세요");
    await prisma.vehicle.update({where: {id: vehicleId}, data: {consentVersion: version, consentedAt: new Date()}});
    return {version};
  }

  async remove(vehicleId: string) {
    return this.lock.run(vehicleId, async () => {
      const vehicle = await prisma.vehicle.findUniqueOrThrow({where: {id: vehicleId}});
      // Invalidate cached authentication first; resolve() also verifies that DB row exists.
      await this.redis.del(vehicleTokenKey(vehicle.tokenHash));
      await prisma.$transaction(async tx => {
        await lockVehicles(tx, [vehicleId]);
        await tx.vehicle.delete({where: {id: vehicleId}});
      });
      // Remove all historical weekly entries without deleting other users' scores.
      let cursor = "0";
      do {
        const result = await this.redis.raw.scan(cursor, "MATCH", "rl:rank:*", "COUNT", 100);
        cursor = result[0];
        for (const key of result[1]) {
          if (await this.redis.raw.type(key) === "zset") await this.redis.raw.zrem(key, vehicleId);
        }
      } while (cursor !== "0");
      await this.redis.raw.zrem(landRankKey(), vehicleId);
      await this.redis.del(vehicleClockKey(vehicleId));
      return {removed: true};
    });
  }

  /** Raw per-trip tile details: 90 days. Dated visits: last seven Seoul dates.
   * Undated tile_records retains purchase eligibility until the user deletes their account.
   * Settlement IDs and financial summaries stay for duplicate prevention and ledger consistency.
   */
  @Cron("0 0 4 * * *", {timeZone: "Asia/Seoul"})
  async cleanup(at = new Date()) {
    const cutoff = new Date(at.getTime() - 90 * 86_400_000);
    await prisma.vehicleTrip.updateMany({where: {endedAt: {lt: cutoff}}, data: {tiles: []}});
    await prisma.tileVisit.deleteMany({where: {day: {lt: daysAgo(seoulDay(at), 6)}}});
  }
}
