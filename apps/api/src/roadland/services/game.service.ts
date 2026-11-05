import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma, prisma, type VehicleTrip } from "@template/database";
import type {
  CarHomeResponse,
  CarRankingResponse,
  CarRecordsResponse,
  CollectResponse,
  LandTileView,
  SubmitTripRequest,
  TileSegment,
  TodaySummary,
  TripResult,
} from "@template/shared";

import { parseTileId, tileId } from "../domain/hex";
import { SPECIAL_BY_ID, SPECIALS } from "../domain/places";
import {
  buyCost,
  incomePerHour,
  isHomeRoute,
  pendingIncome,
  rejectReason,
  RULES,
  seoulDay,
  tripCredits,
  upgradeCost,
  type TileState,
} from "../domain/rules";
import { ClockService } from "./clock.service";
import { RankingService } from "./ranking.service";
import { VehicleLockService } from "./vehicle-lock.service";

type Db = Prisma.TransactionClient;

/** 차가 보낸 종료 시각이 서버 시각보다 이만큼 넘게 미래면 받지 않는다. */
const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * 로드랜드 게임 규칙의 서버 쪽. 잔액·땅·방치 수익의 원본은 DB 이고,
 * 같은 차의 쓰기는 Redis 잠금(VehicleLockService)으로 한 줄로 세운 뒤 DB 트랜잭션에서 처리한다.
 * 방치 수익은 타이머 없이 마지막 수령 시각으로 요청 때 계산한다.
 */
@Injectable()
export class GameService {
  constructor(
    private readonly clock: ClockService,
    private readonly lock: VehicleLockService,
    private readonly ranking: RankingService,
  ) {}

  // --- 조회 -----------------------------------------------------------------

  async home(vehicleId: string): Promise<CarHomeResponse> {
    const now = await this.clock.now(vehicleId);
    const [vehicle, tiles, today, latest] = await Promise.all([
      prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }),
      this.views(prisma, vehicleId, now),
      this.today(prisma, vehicleId, seoulDay(now)),
      prisma.vehicleTrip.findFirst({ where: { vehicleId }, orderBy: { endedAt: "desc" } }),
    ]);
    const owned = tiles.filter((t) => t.owned);
    return {
      credits: vehicle.credits,
      pendingIncome: owned.reduce((n, t) => n + t.pending, 0),
      incomePerHour: owned.reduce((n, t) => n + t.incomePerHour, 0),
      idleCapHours: RULES.idleCapHours,
      ownedTiles: owned.length,
      buyableTiles: tiles.filter((t) => t.buyCost !== null).length,
      today,
      latestTrip: latest ? toTripResult(latest) : null,
      safeStreak: vehicle.safeStreak,
      now: now.toISOString(),
    };
  }

  async territory(vehicleId: string) {
    const now = await this.clock.now(vehicleId);
    return { tiles: await this.views(prisma, vehicleId, now) };
  }

  async records(vehicleId: string): Promise<CarRecordsResponse> {
    const [vehicle, trips, owned, specialVisits] = await Promise.all([
      prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }),
      prisma.vehicleTrip.findMany({
        where: { vehicleId, rejected: false },
        orderBy: { endedAt: "desc" },
        take: 10,
        select: { safetyScore: true },
      }),
      prisma.ownedTile.count({ where: { vehicleId } }),
      prisma.tileVisit.findMany({
        where: { vehicleId, OR: SPECIALS.map((s) => parseTileId(s.id)) },
        distinct: ["q", "r"],
        select: { q: true, r: true },
      }),
    ]);
    const seen = new Set(specialVisits.map((v) => tileId(v.q, v.r)));
    return {
      safeStreak: vehicle.safeStreak,
      bestSafeStreak: vehicle.bestSafeStreak,
      recentScores: trips.map((t) => t.safetyScore).reverse(),
      ownedTiles: owned,
      specials: SPECIALS.map((s) => ({ id: s.id, name: s.name, collected: seen.has(s.id) })),
    };
  }

  async rankings(vehicleId: string): Promise<CarRankingResponse> {
    const day = seoulDay(await this.clock.now(vehicleId));
    const [land, weekly] = await Promise.all([this.ranking.land(vehicleId), this.ranking.weekly(vehicleId, day)]);
    return { land, weekly };
  }

  // --- 주행 정산 --------------------------------------------------------------

  async submitTrip(vehicleId: string, input: SubmitTripRequest): Promise<TripResult> {
    const done = await this.findTrip(vehicleId, input.clientTripId);
    if (done) return done;

    const settled = await this.lock.run(vehicleId, async () => {
      // 잠금을 기다리는 사이 같은 주행이 정산됐을 수 있다.
      const again = await this.findTrip(vehicleId, input.clientTripId);
      if (again) return { trip: again, fresh: false };
      const now = await this.clock.now(vehicleId);
      try {
        return { trip: await prisma.$transaction((tx) => this.settle(tx, vehicleId, input, now)), fresh: true };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const raced = await this.findTrip(vehicleId, input.clientTripId);
          if (raced) return { trip: raced, fresh: false };
        }
        throw e;
      }
    });

    if (settled.fresh && settled.trip.credits > 0) {
      const now = await this.clock.now(vehicleId);
      await this.ranking.addWeekly(vehicleId, seoulDay(now), settled.trip.credits);
    }
    return settled.trip;
  }

  private async settle(tx: Db, vehicleId: string, input: SubmitTripRequest, now: Date): Promise<TripResult> {
    const endedAt = new Date(input.endedAt);
    // 시연 시계를 앞당겼으면 주행 날짜도 같이 민다(실제 운영에서는 shift = 0).
    const shift = now.getTime() - Date.now();
    const day = seoulDay(new Date(endedAt.getTime() + shift));
    const tooNew = endedAt.getTime() > Date.now() + FUTURE_SKEW_MS;
    const rejected = tooNew || rejectReason(input) !== null;
    const c = tripCredits(input);

    const before = rejected ? 0 : await this.driveCredits(tx, vehicleId, day);
    const credits = rejected ? 0 : Math.max(0, Math.min(c.total, RULES.dailyDriveCap - before));
    const capReached = !rejected && before + c.total > RULES.dailyDriveCap;

    let newTiles = 0;
    if (!rejected && input.tiles.length > 0) {
      const ids = [...new Set(input.tiles.map((t) => t.id))];
      const axial = ids.map(parseTileId);
      const known = await tx.tileVisit.findMany({
        where: { vehicleId, q: { in: axial.map((a) => a.q) }, r: { in: axial.map((a) => a.r) } },
        distinct: ["q", "r"],
        select: { q: true, r: true },
      });
      const knownIds = new Set(known.map((k) => tileId(k.q, k.r)));
      newTiles = ids.filter((id) => !knownIds.has(id)).length;
      await tx.tileVisit.createMany({
        data: axial.map(({ q, r }) => ({ vehicleId, q, r, day })),
        skipDuplicates: true,
      });
    }

    const trip = await tx.vehicleTrip.create({
      data: {
        vehicleId,
        clientTripId: input.clientTripId,
        startedAt: new Date(input.startedAt),
        endedAt,
        day,
        km: Math.round(input.km * 10) / 10,
        safetyScore: Math.round(input.safetyScore),
        hardBrakes: input.hardBrakes,
        warnings: input.warnings,
        laneChanges: input.laneChanges,
        signaledLaneChanges: input.signaledLaneChanges,
        tiles: input.tiles as unknown as Prisma.InputJsonValue,
        newTiles,
        credits,
        clean: c.clean,
        assistBonus: c.assistBonus,
        mannerBonus: c.mannerBonus,
        excluded: c.excluded,
        capReached,
        rejected,
      },
    });

    if (!rejected) {
      const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      // 지나간 타일이 없는 주행(위치를 못 받음)은 연속 기록에 넣지 않는다.
      const counts = input.tiles.length > 0;
      const streak = !counts ? vehicle.safeStreak : input.safetyScore >= RULES.safeStreakScore ? vehicle.safeStreak + 1 : 0;
      await tx.vehicle.update({
        where: { id: vehicleId },
        data: {
          credits: { increment: credits },
          safeStreak: streak,
          bestSafeStreak: Math.max(vehicle.bestSafeStreak, streak),
        },
      });
      if (credits > 0) await tx.creditLedger.create({ data: { vehicleId, amount: credits, kind: "TRIP", refId: trip.id } });
    }
    return toTripResult(trip);
  }

  private async findTrip(vehicleId: string, clientTripId: string) {
    const trip = await prisma.vehicleTrip.findUnique({ where: { vehicleId_clientTripId: { vehicleId, clientTripId } } });
    return trip ? toTripResult(trip) : null;
  }

  // --- 땅 --------------------------------------------------------------------

  async buy(vehicleId: string, id: string): Promise<LandTileView> {
    return this.lock.run(vehicleId, async () => {
      const now = await this.clock.now(vehicleId);
      const view = await prisma.$transaction(async (tx) => {
        const tile = (await this.views(tx, vehicleId, now)).find((t) => t.id === id);
        if (!tile || tile.buyCost === null) throw new BadRequestException("지나간 적 있는 빈 땅만 살 수 있어요");
        const cost = tile.buyCost;
        await this.spend(tx, vehicleId, cost, "BUY", id);
        await tx.ownedTile.create({ data: { vehicleId, ...parseTileId(id), level: 1, collectedAt: now } });
        return this.view(tx, vehicleId, id, now);
      });
      await this.refreshLand(vehicleId);
      return view;
    });
  }

  async upgrade(vehicleId: string, id: string): Promise<LandTileView> {
    return this.lock.run(vehicleId, async () => {
      const now = await this.clock.now(vehicleId);
      const view = await prisma.$transaction(async (tx) => {
        const tile = (await this.views(tx, vehicleId, now)).find((t) => t.id === id);
        if (!tile || tile.upgradeCost === null) throw new BadRequestException("더 올릴 수 없는 땅이에요");
        // 올리기 전까지 쌓인 수익은 먼저 받는다(레벨이 바뀌어 계산이 꼬이지 않게).
        if (tile.pending > 0) await this.earn(tx, vehicleId, tile.pending, "COLLECT", id);
        await this.spend(tx, vehicleId, tile.upgradeCost, "UPGRADE", id);
        await tx.ownedTile.update({
          where: { vehicleId_q_r: { vehicleId, ...parseTileId(id) } },
          data: { level: { increment: 1 }, collectedAt: now },
        });
        return this.view(tx, vehicleId, id, now);
      });
      await this.refreshLand(vehicleId);
      return view;
    });
  }

  /** 모든 땅의 방치 수익을 한 번에 받는다. */
  async collect(vehicleId: string): Promise<CollectResponse> {
    return this.lock.run(vehicleId, async () => {
      const now = await this.clock.now(vehicleId);
      return prisma.$transaction(async (tx) => {
        const owned = (await this.views(tx, vehicleId, now)).filter((t) => t.owned);
        const collected = owned.reduce((n, t) => n + t.pending, 0);
        await tx.ownedTile.updateMany({ where: { vehicleId }, data: { collectedAt: now } });
        if (collected > 0) await this.earn(tx, vehicleId, collected, "COLLECT", null);
        const { credits } = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, select: { credits: true } });
        return { collected, credits };
      });
    });
  }

  private async spend(tx: Db, vehicleId: string, amount: number, kind: string, refId: string) {
    // 잔액이 충분할 때만 깎는다. 잠금이 있어도 DB 조건으로 한 번 더 막는다.
    const { count } = await tx.vehicle.updateMany({
      where: { id: vehicleId, credits: { gte: amount } },
      data: { credits: { decrement: amount } },
    });
    if (count === 0) throw new BadRequestException("크레딧이 부족해요");
    await tx.creditLedger.create({ data: { vehicleId, amount: -amount, kind, refId } });
  }

  private async earn(tx: Db, vehicleId: string, amount: number, kind: string, refId: string | null) {
    await tx.vehicle.update({ where: { id: vehicleId }, data: { credits: { increment: amount } } });
    await tx.creditLedger.create({ data: { vehicleId, amount, kind, refId } });
  }

  /** 땅 랭킹 점수(레벨 합)를 DB 에서 다시 계산해 Redis 에 쓴다. */
  async refreshLand(vehicleId: string) {
    const { _sum } = await prisma.ownedTile.aggregate({ where: { vehicleId }, _sum: { level: true } });
    await this.ranking.setLand(vehicleId, _sum.level ?? 0);
  }

  // --- 타일 상태 ---------------------------------------------------------------

  /** 지나간 적이 있거나 내 땅이거나 특별 구간인 타일. */
  private async tiles(db: Db, vehicleId: string): Promise<Map<string, TileState>> {
    const [visits, owned] = await Promise.all([
      db.tileVisit.findMany({ where: { vehicleId }, select: { q: true, r: true, day: true }, orderBy: { day: "asc" } }),
      db.ownedTile.findMany({ where: { vehicleId } }),
    ]);
    const map = new Map<string, TileState>();
    const get = (id: string) => {
      let t = map.get(id);
      if (!t) {
        t = { id, visitDays: [], level: 0, collectedAt: null, special: SPECIAL_BY_ID.get(id) ?? null };
        map.set(id, t);
      }
      return t;
    };
    for (const v of visits) get(tileId(v.q, v.r)).visitDays.push(v.day);
    for (const o of owned) {
      const t = get(tileId(o.q, o.r));
      t.level = o.level;
      t.collectedAt = o.collectedAt;
    }
    for (const s of SPECIALS) get(s.id);
    return map;
  }

  private async views(db: Db, vehicleId: string, now: Date): Promise<LandTileView[]> {
    const tiles = [...(await this.tiles(db, vehicleId)).values()];
    const ownedCount = tiles.filter((t) => t.level > 0).length;
    return tiles.map((t) => toView(t, ownedCount, now));
  }

  private async view(db: Db, vehicleId: string, id: string, now: Date) {
    const view = (await this.views(db, vehicleId, now)).find((t) => t.id === id);
    if (!view) throw new BadRequestException("없는 땅이에요");
    return view;
  }

  private async driveCredits(db: Db, vehicleId: string, day: string) {
    const { _sum } = await db.vehicleTrip.aggregate({ where: { vehicleId, day }, _sum: { credits: true } });
    return _sum.credits ?? 0;
  }

  private async today(db: Db, vehicleId: string, day: string): Promise<TodaySummary> {
    const trips = await db.vehicleTrip.findMany({ where: { vehicleId, day } });
    const ids = [...new Set(trips.flatMap((t) => (t.tiles as unknown as TileSegment[]).map((x) => x.id)))];
    return {
      trips: trips.length,
      km: Math.round(trips.reduce((s, t) => s + t.km, 0) * 10) / 10,
      newTiles: trips.reduce((s, t) => s + t.newTiles, 0),
      tilesPassed: ids.length,
      tileIds: ids,
      driveCredits: trips.reduce((s, t) => s + t.credits, 0),
      driveCap: RULES.dailyDriveCap,
    };
  }
}

function toView(t: TileState, ownedCount: number, now: Date): LandTileView {
  const today = seoulDay(now);
  const owned = t.level > 0;
  const visited = t.visitDays.length > 0;
  return {
    id: t.id,
    visitDays: t.visitDays,
    level: t.level,
    collectedAt: t.collectedAt?.toISOString() ?? null,
    special: t.special,
    owned,
    homeRoute: isHomeRoute(t, today),
    incomePerHour: incomePerHour(t, today),
    pending: pendingIncome(t, now),
    buyCost: !owned && visited ? buyCost(ownedCount) : null,
    upgradeCost: owned ? upgradeCost(t.level) : null,
  };
}

export function toTripResult(t: VehicleTrip): TripResult {
  return {
    id: t.id,
    clientTripId: t.clientTripId,
    endedAt: t.endedAt.toISOString(),
    km: t.km,
    safetyScore: t.safetyScore,
    hardBrakes: t.hardBrakes,
    warnings: t.warnings,
    laneChanges: t.laneChanges,
    signaledLaneChanges: t.signaledLaneChanges,
    tiles: t.tiles as unknown as TileSegment[],
    newTiles: t.newTiles,
    credits: t.credits,
    breakdown: { clean: t.clean, assistBonus: t.assistBonus, mannerBonus: t.mannerBonus, excluded: t.excluded },
    capReached: t.capReached,
    rejected: t.rejected,
  };
}
