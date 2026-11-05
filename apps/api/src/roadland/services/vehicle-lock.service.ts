import { ConflictException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { RedisService } from "../../shared/redis/redis.service";
import { vehicleLockKey } from "../../shared/redis/keys";

const LOCK_TTL_MS = 10_000;
const WAIT_MS = 3_000;
const RETRY_MS = 50;

// 내가 잡은 잠금일 때만 푼다(만료 뒤 다른 요청이 잡은 잠금을 지우지 않게).
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * 차량별 Redis 잠금. 같은 차의 쓰기 요청(주행 정산·구매·업그레이드·수령)을 한 줄로 세운다.
 * 차는 주행 큐를 재전송하고 화면에서 버튼을 연달아 누를 수 있어, 잔액 계산이 겹치지 않게 한다.
 * DB 트랜잭션은 그대로 쓰고, 이 잠금은 그 앞에서 순서만 정한다.
 */
@Injectable()
export class VehicleLockService {
  constructor(private readonly redis: RedisService) {}

  async run<T>(vehicleId: string, work: () => Promise<T>): Promise<T> {
    const key = vehicleLockKey(vehicleId);
    const owner = randomUUID();
    const deadline = Date.now() + WAIT_MS;
    while ((await this.redis.raw.set(key, owner, "PX", LOCK_TTL_MS, "NX")) !== "OK") {
      if (Date.now() > deadline) throw new ConflictException("다른 요청을 처리하고 있어요. 잠시 뒤 다시 시도해 주세요");
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    try {
      return await work();
    } finally {
      await this.redis.raw.eval(RELEASE, 1, key, owner);
    }
  }
}
