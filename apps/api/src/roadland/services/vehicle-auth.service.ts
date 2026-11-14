import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@loadland/database";
import type { RegisterDeviceResponse } from "@loadland/shared";

import { RedisService } from "../../shared/redis/redis.service";
import { vehicleTokenKey } from "../../shared/redis/keys";
import { RULES } from "../domain/rules";

const TOKEN_CACHE_SEC = 24 * 60 * 60;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * 차량 기기 인증. 차가 처음 켜질 때 토큰을 받아 저장하고, 이후 요청마다 Bearer 로 보낸다.
 * 사용자 로그인(JWT)과는 별개다. 차 = 계정(MVP).
 */
@Injectable()
export class VehicleAuthService {
  constructor(private readonly redis: RedisService) {}

  async register(): Promise<RegisterDeviceResponse> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hash(token);
    const vehicle = await prisma.$transaction(async (tx) => {
      const v = await tx.vehicle.create({ data: { tokenHash, credits: RULES.welcomeCredits } });
      await tx.creditLedger.create({ data: { vehicleId: v.id, amount: RULES.welcomeCredits, kind: "WELCOME" } });
      return v;
    });
    await this.redis.set(vehicleTokenKey(tokenHash), vehicle.id, TOKEN_CACHE_SEC);
    return { vehicleId: vehicle.id, token };
  }

  /** 토큰의 차량 ID. 모르는 토큰이면 null. */
  async resolve(token: string): Promise<string | null> {
    const tokenHash = hash(token);
    const cached = await this.redis.get(vehicleTokenKey(tokenHash));
    if (cached) return cached;
    const vehicle = await prisma.vehicle.findUnique({ where: { tokenHash }, select: { id: true } });
    if (!vehicle) return null;
    await this.redis.set(vehicleTokenKey(tokenHash), vehicle.id, TOKEN_CACHE_SEC);
    return vehicle.id;
  }

  /** 차량을 지울 때 캐시도 지운다(지워진 차의 토큰이 캐시로 통과하지 않게). */
  async forgetVehicle(vehicleId: string) {
    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { tokenHash: true } });
    if (v) await this.redis.del(vehicleTokenKey(v.tokenHash));
  }
}
