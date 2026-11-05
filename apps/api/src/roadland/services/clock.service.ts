import { Injectable } from "@nestjs/common";

import { RedisService } from "../../shared/redis/redis.service";
import { vehicleClockKey } from "../../shared/redis/keys";

export const devToolsEnabled = () => process.env.ROADLAND_DEV_TOOLS === "true";

/**
 * 게임 시계. 시연에서 방치 수익을 보여 주려고 차량별로 시간을 앞당길 수 있다(Redis 에 오프셋 저장).
 * 시연 도구가 꺼져 있으면 항상 실제 시각이다.
 */
@Injectable()
export class ClockService {
  constructor(private readonly redis: RedisService) {}

  async now(vehicleId: string): Promise<Date> {
    if (!devToolsEnabled()) return new Date();
    const offset = Number(await this.redis.get(vehicleClockKey(vehicleId))) || 0;
    return new Date(Date.now() + offset);
  }

  async advance(vehicleId: string, hours: number): Promise<Date> {
    await this.redis.raw.incrby(vehicleClockKey(vehicleId), Math.round(hours * 3_600_000));
    return this.now(vehicleId);
  }

  async reset(vehicleId: string) {
    await this.redis.del(vehicleClockKey(vehicleId));
  }
}
