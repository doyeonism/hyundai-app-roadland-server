import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
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
  constructor(private readonly auth: VehicleAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<VehicleRequest>();
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !token) throw new UnauthorizedException("차량 토큰이 없어요");
    const vehicleId = await this.auth.resolve(token);
    if (!vehicleId) throw new UnauthorizedException("등록되지 않은 차량이에요");
    req.vehicleId = vehicleId;
    return true;
  }
}

/** 시연 도구 라우트는 ROADLAND_DEV_TOOLS=true 일 때만 존재하는 것처럼 보인다. */
@Injectable()
export class DevToolsGuard implements CanActivate {
  canActivate(): boolean {
    if (!devToolsEnabled()) throw new NotFoundException();
    return true;
  }
}

/** VehicleGuard 가 확인한 차량 ID. */
export const VehicleId = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<VehicleRequest>().vehicleId!;
});
