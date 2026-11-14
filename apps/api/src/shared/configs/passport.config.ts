import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { Role } from "@roadland/shared";

import * as CONST from "../constants";
import { RedisService } from "../redis/redis.service";
import { suspendedKey } from "../redis/keys";
import { getCookieName } from "../utils";

interface JwtPayload {
  userId: string;
  email: string;
  role: Role;
}

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(private readonly redis: RedisService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request): string | null => {
          return (request?.cookies?.[getCookieName("access_token")] as string) ?? null;
        },
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: CONST.ACCESS_TOKEN_SECRET,
    });
  }

  async validate(payload: JwtPayload) {
    // 관리자가 계정을 정지하면 Redis 에 플래그가 세팅된다(TTL = 액세스 토큰 만료).
    // 서명이 유효한 토큰이라도 정지된 계정이면 즉시 거부해, 정지가 최대 30분 늦게
    // 반영되는 문제를 막는다. DB 조회 없이 Redis GET 한 번이다.
    if (await this.redis.get(suspendedKey(payload.userId))) {
      throw new UnauthorizedException("정지된 계정입니다. 관리자에게 문의하세요.");
    }
    // Inject this object into request.user
    return { userId: payload.userId, email: payload.email, role: payload.role };
  }
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  "jwt-refresh",
) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request): string | null => {
          return (request?.cookies?.[getCookieName("refresh_token")] as string) ?? null;
        },
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: CONST.REFRESH_TOKEN_SECRET,
      passReqToCallback: true,
    });
  }

  validate(req: Request, payload: JwtPayload) {
    const refreshToken =
      (req.cookies?.[getCookieName("refresh_token")] as string) ??
      req.get("Authorization")?.replace("Bearer ", "").trim() ??
      "";

    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
      refreshToken,
    };
  }
}
