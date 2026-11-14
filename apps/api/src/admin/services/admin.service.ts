import { Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@loadland/database";
import {
  buildPaginatedData,
  resolvePagination,
  USER_STATUS,
  type PaginationQuery,
  type Role,
  type UpdateUserRequest,
} from "@loadland/shared";

import * as CONST from "../../shared/constants";
import { RedisService } from "../../shared/redis/redis.service";
import { refreshKey, suspendedKey } from "../../shared/redis/keys";

const USER_SORTABLE_FIELDS = [
  "createdAt",
  "email",
  "nickname",
  "role",
] as const;

@Injectable()
export class AdminService {
  constructor(private readonly redis: RedisService) {}

  /** 관리자 본인 정보 — admin 앱의 SSR 가드가 역할 확인 + 사이드바 표시용으로 호출 */
  async me(userId: string | undefined) {
    const user = userId
      ? await prisma.user.findUnique({
          where: { id: userId },
          omit: { password: true },
        })
      : null;
    if (!user) {
      throw new NotFoundException("존재하지 않는 사용자입니다.");
    }
    return { user };
  }

  /** 사용자 목록 (공통 페이지네이션 유틸 사용) */
  async listUsers(query: PaginationQuery) {
    const { page, pageSize, skip, take, order, sort, search } =
      resolvePagination(query);

    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { nickname: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    const sortField = USER_SORTABLE_FIELDS.includes(
      sort as (typeof USER_SORTABLE_FIELDS)[number],
    )
      ? (sort as string)
      : "createdAt";

    const [items, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: order },
        omit: { password: true },
        include: {
          termsAgreements: {
            include: {
              terms: true,
            },
            orderBy: {
              agreedAt: "desc",
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return buildPaginatedData(items, { page, pageSize, total });
  }

  /** 사용자 역할 변경 (승격/강등) — ADMIN 전용 */
  async updateUserRole(id: string, role: Role) {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw new NotFoundException("존재하지 않는 사용자입니다.");
    }

    const user = await prisma.user.update({
      where: { id },
      data: { role },
      omit: { password: true },
    });

    return { user };
  }

  /** 사용자 정보 수정 (닉네임·계정 상태) — ADMIN 전용. 전달된 필드만 부분 수정. */
  async updateUser(id: string, dto: UpdateUserRequest) {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw new NotFoundException("존재하지 않는 사용자입니다.");
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(dto.nickname !== undefined ? { nickname: dto.nickname } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
      omit: { password: true },
    });

    // 상태 변경을 세션에 즉시 반영한다.
    // - SUSPENDED: refresh 토큰 폐기(재발급 불가) + 정지 플래그(이미 발급된 액세스 토큰도 거부)
    // - 그 외로 복귀: 정지 플래그 해제 (다시 로그인하면 된다)
    if (dto.status !== undefined) {
      if (dto.status === USER_STATUS.SUSPENDED) {
        await this.redis.del(refreshKey(id));
        await this.redis.set(
          suspendedKey(id),
          "1",
          CONST.ACCESS_TOKEN_EXPIRED_IN_SEC,
        );
      } else {
        await this.redis.del(suspendedKey(id));
      }
    }

    return { user };
  }

  /** 구독 목록 (페이지네이션·정렬·검색) */
  async listSubscriptions(query: PaginationQuery) {
    const { page, pageSize, skip, take, order, sort, search } =
      resolvePagination(query);

    const where = search
      ? {
          user: {
            OR: [
              { email: { contains: search, mode: "insensitive" as const } },
              { nickname: { contains: search, mode: "insensitive" as const } },
            ],
          },
        }
      : {};

    const sortField = [
      "createdAt",
      "startDate",
      "endDate",
      "nextPaymentDate",
    ].includes(sort as string)
      ? (sort as string)
      : "createdAt";

    const [items, total] = await prisma.$transaction([
      prisma.userSubscription.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: order },
        include: {
          user: {
            select: {
              email: true,
              nickname: true,
            },
          },
          plan: true,
        },
      }),
      prisma.userSubscription.count({ where }),
    ]);

    return buildPaginatedData(items, { page, pageSize, total });
  }
}