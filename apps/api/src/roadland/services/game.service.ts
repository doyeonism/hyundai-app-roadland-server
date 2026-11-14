import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Prisma, prisma, type VehicleTrip } from "@loadland/database";
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
} from "@loadland/shared";

import { parseTileId, tileId } from "../domain/hex";
import {
  buyCost,
  collectedUntil,
  incomePerHour,
  incomePerDay,
  isGoodTrip,
  isHomeRoute,
  pendingIncome,
  rejectReason,
  RULES,
  seoulDay,
  tripCredits,
  type TileState,
  upgradeCost,
} from "../domain/rules";
import { ClockService } from "./clock.service";
import { RankingService } from "./ranking.service";
import { VehicleLockService } from "./vehicle-lock.service";

type Db = Prisma.TransactionClient;

/** 차 한 대가 보는 타일 상태. 주인이 다른 차면 level 은 0(내 땅 아님)이고 price 만 의미가 있다. */
interface TileInfo extends TileState {
  /** 지금 주인. 없으면 null. */
  ownerId: string | null;
  /** 마지막 거래가. 주인이 없으면 null. */
  price: number | null;
  /** 마지막 거래 시각과 내가 마지막으로 지나간 시각. 주인이 있으면 거래 뒤에 지나가야 살 수 있다. */
  tradedAt: Date | null;
  lastPassedAt: Date | null;
}

interface OwnedRow {
  q: number;
  r: number;
  vehicle_id: string;
  price: number;
  level: number;
  collected_at: Date;
  traded_at: Date;
}

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
      personalLevel: vehicle.personalLevel,
      personalUpgradeCost: upgradeCost(vehicle.personalLevel),
      incomePerTilePerDay: incomePerDay({level: vehicle.personalLevel}),
      nextIncomePerTilePerDay: upgradeCost(vehicle.personalLevel) === null ? null : incomePerDay({level: vehicle.personalLevel + 1}),
      pendingIncome: owned.reduce((n, t) => n + t.pending, 0),
      incomePerHour: owned.reduce((n, t) => n + t.incomePerHour, 0),
      incomePerDay: owned.reduce((n, t) => n + (t.incomePerDay ?? 0), 0),
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
    const [vehicle, trips, owned] = await Promise.all([
      prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }),
      prisma.vehicleTrip.findMany({
        where: { vehicleId, rejected: false },
        orderBy: { endedAt: "desc" },
        take: 10,
        select: { safetyScore: true },
      }),
      prisma.ownedTile.count({ where: { vehicleId } }),
    ]);
    return {
      safeStreak: vehicle.safeStreak,
      bestSafeStreak: vehicle.bestSafeStreak,
      recentScores: trips.map((t) => t.safetyScore).reverse(),
      ownedTiles: owned,
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
      // 땅 수익에 쓰는 칸별 주행 수(안전 점수 기준을 넘은 주행과 아닌 주행)와 마지막으로 지나간 시각.
      const good = isGoodTrip(input.safetyScore) ? 1 : 0;
      const passedAt = new Date(endedAt.getTime() + shift);
      await tx.$executeRaw`
        INSERT INTO tile_records (vehicle_id, q, r, good_trips, bad_trips, last_passed_at)
        SELECT ${vehicleId}, t.q, t.r, ${good}, ${1 - good}, ${passedAt}
        FROM unnest(${axial.map((a) => a.q)}::int[], ${axial.map((a) => a.r)}::int[]) AS t(q, r)
        ON CONFLICT (vehicle_id, q, r) DO UPDATE SET
          good_trips = tile_records.good_trips + EXCLUDED.good_trips,
          bad_trips = tile_records.bad_trips + EXCLUDED.bad_trips,
          last_passed_at = GREATEST(tile_records.last_passed_at, EXCLUDED.last_passed_at)`;
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

  /**
   * 땅을 산다. 주인 없는 땅은 기본값, 다른 차의 땅은 마지막 거래가 + 인상분을 낸다(낸 돈은 아무에게도 가지 않는다).
   * 빼앗길 때 이전 주인은 그 땅에 쌓인 수익을 먼저 받고, 땅은 레벨 1로 넘어간다.
   */
  async buy(vehicleId: string, id: string): Promise<LandTileView> {
    const key = parseTileId(id);
    // 이전 주인도 함께 잠가야 그 차의 수령·업그레이드와 겹치지 않는다. 잠근 뒤 주인이 그대로인지 다시 본다.
    const seen = await prisma.ownedTile.findUnique({ where: { q_r: key }, select: { vehicleId: true } });
    const prevOwner = seen && seen.vehicleId !== vehicleId ? seen.vehicleId : null;
    const view = await this.lock.runAll([vehicleId, ...(prevOwner ? [prevOwner] : [])], async () => {
      const now = await this.clock.now(vehicleId);
      try {
        return await prisma.$transaction(async (tx) => {
          const all = await this.tiles(tx, vehicleId);
          const tile = all.get(id);
          if (!tile || tile.visitDays.length === 0) throw new BadRequestException("직접 지나간 땅만 살 수 있어요");
          if (tile.ownerId === vehicleId) throw new BadRequestException("이미 내 땅이에요");
          if (tile.ownerId !== prevOwner) throw new ConflictException("방금 주인이 바뀌었어요. 다시 확인해 주세요");
          if (mustRevisit(tile)) throw new BadRequestException("주인이 바뀐 뒤에 다시 지나가야 살 수 있어요");
          const cost = buyCost(tile.price, ownedCount(all.values(), vehicleId));
          await this.spend(tx, vehicleId, cost, "BUY", id);
          if (tile.ownerId === null || tile.price === null) {
            await tx.ownedTile.create({ data: { ...key, vehicleId, price: cost, level: 1, collectedAt: now, tradedAt: now } });
          } else {
            const owned = await tx.ownedTile.findUniqueOrThrow({ where: { q_r: key } });
            const record = await tx.tileRecord.findUnique({ where: { vehicleId_q_r: { vehicleId: owned.vehicleId, ...key } } });
            const previousOwner = await tx.vehicle.findUniqueOrThrow({where: {id: owned.vehicleId}});
            const pending = pendingIncome(
              {
                level: previousOwner.personalLevel,
                collectedAt: owned.collectedAt,
                goodTrips: record?.goodTrips ?? 0,
                badTrips: record?.badTrips ?? 0,
              },
              await this.clock.now(owned.vehicleId),
            );
            if (pending > 0) await this.earn(tx, owned.vehicleId, pending, "COLLECT", id);
            const { count } = await tx.ownedTile.updateMany({
              where: { ...key, vehicleId: owned.vehicleId, price: tile.price },
              data: { vehicleId, price: cost, level: 1, collectedAt: now, tradedAt: now },
            });
            if (count === 0) throw new ConflictException("방금 주인이 바뀌었어요. 다시 확인해 주세요");
          }
          return this.view(tx, vehicleId, id, now);
        });
      } catch (e) {
        // 주인 없는 땅을 다른 차가 같은 순간에 먼저 샀다.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new ConflictException("다른 차가 먼저 샀어요. 다시 확인해 주세요");
        }
        throw e;
      }
    });
    await this.refreshLand(vehicleId);
    if (prevOwner) await this.refreshLand(prevOwner);
    return view;
  }

  /** 구버전 클라이언트가 땅별 레벨을 결제하지 않도록 명시적으로 거절한다. */
  async upgrade(_vehicleId: string, _id: string): Promise<LandTileView> {
    throw new BadRequestException("홈에서 개인 레벨을 올려 주세요");
  }

  async upgradePersonal(vehicleId: string, expectedLevel: number): Promise<CarHomeResponse> {
    if (!Number.isInteger(expectedLevel) || expectedLevel < 1 || expectedLevel > 60) {
      throw new BadRequestException("현재 개인 레벨을 확인해 주세요");
    }
    return this.lock.run(vehicleId, async () => {
      const now = await this.clock.now(vehicleId);
      await prisma.$transaction(async tx => {
        const vehicle = await tx.vehicle.findUniqueOrThrow({where: {id: vehicleId}});
        if (vehicle.personalLevel !== expectedLevel) throw new ConflictException("레벨이 변경됐어요. 새로고침해 주세요");
        const cost = upgradeCost(vehicle.personalLevel);
        if (cost === null) throw new BadRequestException("이미 최고 레벨이에요");
        // 보유 잔액으로 먼저 결제한다. 부족하면 아래 수익 정산과 레벨 변경도 전부 취소된다.
        await this.spend(tx, vehicleId, cost, "PERSONAL_UPGRADE", String(expectedLevel + 1));
        const owned = (await this.views(tx, vehicleId, now)).filter(t => t.owned);
        const pending = owned.reduce((sum, t) => sum + t.pending, 0);
        if (pending > 0) await this.earn(tx, vehicleId, pending, "COLLECT", null);
        await tx.ownedTile.updateMany({where: {vehicleId}, data: {collectedAt: now}});
        await tx.vehicle.update({where: {id: vehicleId}, data: {personalLevel: {increment: 1}}});
      });
      return this.home(vehicleId);
    });
  }

  /** 모든 땅의 방치 수익을 한 번에 받는다. */
  async collect(vehicleId: string): Promise<CollectResponse> {
    return this.lock.run(vehicleId, async () => {
      const now = await this.clock.now(vehicleId);
      return prisma.$transaction(async (tx) => {
        const owned = (await this.views(tx, vehicleId, now)).filter((t) => t.owned);
        const collected = owned.reduce((n, t) => n + t.pending, 0);
        // 땅마다 다 찬 분만큼만 기준 시각을 옮긴다(1분이 안 찬 몫은 남긴다). 같은 시각끼리 묶어 갱신한다.
        const groups = new Map<number, { q: number; r: number }[]>();
        for (const t of owned) {
          const until = collectedUntil(new Date(t.collectedAt!), now, t).getTime();
          groups.set(until, [...(groups.get(until) ?? []), parseTileId(t.id)]);
        }
        for (const [until, keys] of groups) {
          await tx.ownedTile.updateMany({ where: { vehicleId, OR: keys }, data: { collectedAt: new Date(until) } });
        }
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

  /** 이 차가 지나간 적이 있거나 이 차의 땅인 타일. 지나간 칸에 다른 차가 주인이면 그 거래가도 붙인다. */
  private async tiles(db: Db, vehicleId: string): Promise<Map<string, TileInfo>> {
    const [visits, records, owned, vehicle] = await Promise.all([
      db.tileVisit.findMany({ where: { vehicleId }, select: { q: true, r: true, day: true }, orderBy: { day: "asc" } }),
      db.tileRecord.findMany({ where: { vehicleId } }),
      db.$queryRaw<OwnedRow[]>`
        SELECT o.q, o.r, o.vehicle_id, o.price, o.level, o.collected_at, o.traded_at FROM owned_tiles o
        WHERE o.vehicle_id = ${vehicleId}
           OR EXISTS (SELECT 1 FROM tile_visits v WHERE v.vehicle_id = ${vehicleId} AND v.q = o.q AND v.r = o.r)`,
      db.vehicle.findUniqueOrThrow({where: {id: vehicleId}}),
    ]);
    const map = new Map<string, TileInfo>();
    const get = (id: string) => {
      let t = map.get(id);
      if (!t) {
        t = {
          id,
          visitDays: [],
          level: 0,
          collectedAt: null,
          goodTrips: 0,
          badTrips: 0,
          ownerId: null,
          price: null,
          tradedAt: null,
          lastPassedAt: null,
        };
        map.set(id, t);
      }
      return t;
    };
    for (const v of visits) get(tileId(v.q, v.r)).visitDays.push(v.day);
    for (const r of records) {
      Object.assign(get(tileId(r.q, r.r)), { goodTrips: r.goodTrips, badTrips: r.badTrips, lastPassedAt: r.lastPassedAt });
    }
    for (const o of owned) {
      const t = get(tileId(o.q, o.r));
      t.ownerId = o.vehicle_id;
      t.price = o.price;
      t.tradedAt = o.traded_at;
      if (o.vehicle_id === vehicleId) {
        t.level = vehicle.personalLevel;
        t.collectedAt = o.collected_at;
      }
    }
    return map;
  }

  private async views(db: Db, vehicleId: string, now: Date): Promise<LandTileView[]> {
    const tiles = [...(await this.tiles(db, vehicleId)).values()];
    const owned = ownedCount(tiles, vehicleId);
    return tiles.map((t) => toView(t, vehicleId, owned, now));
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

/** 다른 차의 땅인데, 내가 마지막으로 지나간 때가 마지막 거래보다 앞이라 다시 지나가야 하는지. */
function mustRevisit(t: TileInfo) {
  if (t.ownerId === null || t.tradedAt === null) return false;
  return t.lastPassedAt === null || t.lastPassedAt <= t.tradedAt;
}

function ownedCount(tiles: Iterable<TileInfo>, vehicleId: string) {
  let n = 0;
  for (const t of tiles) if (t.ownerId === vehicleId) n++;
  return n;
}

function toView(t: TileInfo, vehicleId: string, ownedByMe: number, now: Date): LandTileView {
  const owned = t.ownerId === vehicleId;
  const visited = t.visitDays.length > 0;
  const revisit = !owned && mustRevisit(t);
  return {
    id: t.id,
    visitDays: t.visitDays,
    level: t.level,
    collectedAt: t.collectedAt?.toISOString() ?? null,
    owned,
    ownedByOther: t.ownerId !== null && !owned,
    price: t.price,
    homeRoute: isHomeRoute(t, seoulDay(now)),
    goodTrips: t.goodTrips,
    badTrips: t.badTrips,
    incomePerHour: incomePerHour(t),
    incomePerDay: incomePerDay(t),
    nextLevelIncomePerDay: null,
    pending: pendingIncome(t, now),
    mustRevisit: visited && revisit,
    buyCost: !owned && visited && !revisit ? buyCost(t.price, ownedByMe) : null,
    upgradeCost: null,
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
