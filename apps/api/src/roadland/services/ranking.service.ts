import { Injectable } from "@nestjs/common";
import type { RankingBoard, RankingEntry } from "@loadland/shared";

import { RedisService } from "../../shared/redis/redis.service";
import { landRankKey, weeklyRankKey } from "../../shared/redis/keys";
import { seoulWeek } from "../domain/rules";

const TOP = 10;
const WEEKLY_TTL_SEC = 15 * 24 * 60 * 60;

/** 익명 표시명. 차량 ID 앞자리만 보여 준다. */
const displayName = (vehicleId: string) => `차량 ${vehicleId.slice(0, 4).toUpperCase()}`;

/**
 * 랭킹은 Redis sorted set 에만 둔다. DB 가 원본이고, 지워져도 다음 정산·구매 때 다시 채워진다.
 * 땅 점수는 덮어쓰고(ZADD), 주간 주행 크레딧은 더한다(ZINCRBY).
 */
@Injectable()
export class RankingService {
  constructor(private readonly redis: RedisService) {}

  async setLand(vehicleId: string, score: number) {
    if (score > 0) await this.redis.raw.zadd(landRankKey(), score, vehicleId);
    else await this.redis.raw.zrem(landRankKey(), vehicleId);
  }

  async addWeekly(vehicleId: string, day: string, credits: number) {
    if (credits <= 0) return;
    const key = weeklyRankKey(seoulWeek(day));
    await this.redis.raw.multi().zincrby(key, credits, vehicleId).expire(key, WEEKLY_TTL_SEC).exec();
  }

  async remove(vehicleId: string, day: string) {
    await this.redis.raw.multi().zrem(landRankKey(), vehicleId).zrem(weeklyRankKey(seoulWeek(day)), vehicleId).exec();
  }

  land(vehicleId: string) {
    return this.board(landRankKey(), vehicleId);
  }

  weekly(vehicleId: string, day: string) {
    return this.board(weeklyRankKey(seoulWeek(day)), vehicleId);
  }

  private async board(key: string, vehicleId: string): Promise<RankingBoard> {
    const [raw, myRank, myScore] = await Promise.all([
      this.redis.raw.zrevrange(key, 0, TOP - 1, "WITHSCORES"),
      this.redis.raw.zrevrank(key, vehicleId),
      this.redis.raw.zscore(key, vehicleId),
    ]);
    const top: RankingEntry[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      top.push({ rank: i / 2 + 1, name: displayName(raw[i]), score: Number(raw[i + 1]), me: raw[i] === vehicleId });
    }
    const mine =
      myRank === null || myScore === null
        ? null
        : { rank: myRank + 1, name: displayName(vehicleId), score: Number(myScore), me: true };
    return { top, mine };
  }
}
