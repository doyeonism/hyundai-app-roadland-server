import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NotFoundException,
  HttpException,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { RedisService } from "../../shared/redis/redis.service";
import type { Request } from "express";

import { devToolsEnabled } from "../services/clock.service";
import { VehicleAuthService } from "../services/vehicle-auth.service";

type VehicleRequest = Request & { vehicleId?: string };

/**
 * 차량 기기 토큰(`Authorization: Bearer <token>`) 검증. 컨트롤러는 @Public() 으로 사용자 JWT 가드를 건너뛰고
 * 이 가드로 차량을 확인한다. 토큰 → 차량 ID 는 Redis 에 캐시한다.
 */
@Injectable()
export class VehicleGuard implements CanActivate {
  constructor(private readonly auth: VehicleAuthService, private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<VehicleRequest>();
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !token) throw new UnauthorizedException("차량 토큰이 없어요");
    const vehicleId = await this.auth.resolve(token);
    if (!vehicleId) throw new UnauthorizedException("등록되지 않은 차량이에요");
    const key = `roadland:rate:${vehicleId}:${Math.floor(Date.now() / 60_000)}`;
    const count = await this.redis.raw.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],120) end; return n", 1, key,
    ) as number;
    if (count > 90) throw new HttpException("요청이 많아요. 잠시 뒤 다시 시도해 주세요", 429);
    req.vehicleId = vehicleId;
    return true;
  }
}

/** 시연 도구 라우트는 ROADLAND_DEV_TOOLS=true 일 때만 존재하는 것처럼 보인다. */
@Injectable()
export class DevToolsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!devToolsEnabled()) throw new NotFoundException();
    // Test/local only can run without a secret. Any other environment requires it.
    const secret = process.env.ROADLAND_DEV_TOKEN;
    const env = process.env.NODE_ENV;
    const local = env === "development" || env === "test";
    if (!secret && !local) throw new NotFoundException();
    if (secret) {
      const supplied = String(context.switchToHttp().getRequest<Request>().headers["x-roadland-dev-token"] ?? "");
      const a = Buffer.from(secret), b = Buffer.from(supplied);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    }
    return true;
  }
}

/** VehicleGuard 가 확인한 차량 ID. */
export const VehicleId = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<VehicleRequest>().vehicleId!;
});
