import { Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@template/database";

import { parseTileId } from "../domain/hex";
import { COMMUTE, RIVERSIDE, routeTiles, sampleRoute } from "../domain/places";
import { daysAgo, isGoodTrip, RULES, seoulDay, tripCredits } from "../domain/rules";
import { ClockService } from "./clock.service";
import { GameService } from "./game.service";
import { RankingService } from "./ranking.service";
import { VehicleAuthService } from "./vehicle-auth.service";
import { VehicleLockService } from "./vehicle-lock.service";

const HOUR = 3_600_000;

/** 시연 도구. ROADLAND_DEV_TOOLS=true 일 때만 라우트가 열린다. */
@Injectable()
export class DemoService {
  constructor(
    private readonly clock: ClockService,
    private readonly lock: VehicleLockService,
    private readonly game: GameService,
    private readonly ranking: RankingService,
    private readonly auth: VehicleAuthService,
  ) {}

  async vehicles() {
    const list = await prisma.vehicle.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, credits: true, createdAt: true, _count: { select: { trips: true, tiles: true } } },
    });
    return list.map((v) => ({ id: v.id, credits: v.credits, createdAt: v.createdAt, trips: v._count.trips, ownedTiles: v._count.tiles }));
  }

  async advance(vehicleId: string, hours: number) {
    await this.ensure(vehicleId);
    return { now: (await this.clock.advance(vehicleId, hours)).toISOString() };
  }

  /** 처음 등록한 상태로 되돌린다(토큰은 그대로). */
  async reset(vehicleId: string) {
    await this.ensure(vehicleId);
    await this.lock.run(vehicleId, async () => {
      const day = seoulDay(await this.clock.now(vehicleId));
      await prisma.$transaction([
        prisma.vehicleTrip.deleteMany({ where: { vehicleId } }),
        prisma.tileVisit.deleteMany({ where: { vehicleId } }),
        prisma.tileRecord.deleteMany({ where: { vehicleId } }),
        prisma.ownedTile.deleteMany({ where: { vehicleId } }),
        prisma.creditLedger.deleteMany({ where: { vehicleId } }),
        prisma.vehicle.update({
          where: { id: vehicleId },
          data: { credits: RULES.welcomeCredits, safeStreak: 0, bestSafeStreak: 0 },
        }),
        prisma.creditLedger.create({ data: { vehicleId, amount: RULES.welcomeCredits, kind: "WELCOME" } }),
      ]);
      await this.clock.reset(vehicleId);
      await this.ranking.remove(vehicleId, day);
    });
    return { reset: true };
  }

  /**
   * 시연용 기록을 채운다: 집 근처 출근길 앞쪽 절반을 지난 며칠 지나갔고(홈 루트), 그중 몇 칸은 이미 내 땅,
   * 주말에 한강 쪽 길을 한 번 다녀왔다. 최근 안전 점수 몇 개와 연속 기록도 넣는다.
   */
  async seed(vehicleId: string) {
    await this.reset(vehicleId);
    await this.lock.run(vehicleId, async () => {
      const now = await this.clock.now(vehicleId);
      const today = seoulDay(now);
      const commute = routeTiles(COMMUTE);
      const known = commute.slice(0, Math.ceil(commute.length / 2));
      const pastDays = [daysAgo(today, 4), daysAgo(today, 2), daysAgo(today, 1)];
      const visits = [
        ...known.flatMap((id) => pastDays.map((day) => ({ vehicleId, ...parseTileId(id), day }))),
        ...routeTiles(RIVERSIDE).map((id) => ({ vehicleId, ...parseTileId(id), day: daysAgo(today, 5) })),
      ];
      const owned = known
        .map((id, i) => ({ id, i }))
        .filter(({ i }) => i % 3 === 0 && i < 12)
        .map(({ id, i }) => ({
          vehicleId,
          ...parseTileId(id),
          price: RULES.buyBaseCost,
          level: i < 4 ? 2 : 1,
          collectedAt: new Date(now.getTime() - 5 * HOUR),
        }));
      const scores = [88, 92, 95, 97, 100];
      const segment = (id: string) => ({ id, hardBrake: false, warning: false, assisted: false });
      // 지난 출근길 기록. 크레딧은 정산 규칙대로 적어 두되 잔액은 아래에서 시연 값으로 맞춘다.
      const paid = tripCredits({ tiles: known.map(segment), laneChanges: 4, signaledLaneChanges: 4 });
      const trips = scores.map((score, n) => {
        const day = daysAgo(today, scores.length - n);
        const endedAt = new Date(`${day}T08:40:00+09:00`);
        return {
          vehicleId,
          clientTripId: `demo-seed-${n}`,
          startedAt: new Date(endedAt.getTime() - 25 * 60_000),
          endedAt,
          day,
          km: Math.round(sampleRoute(COMMUTE).length * 0.03 * 5) / 10,
          safetyScore: score,
          hardBrakes: score < 90 ? 1 : 0,
          warnings: 0,
          laneChanges: 4,
          signaledLaneChanges: 4,
          tiles: known.map(segment),
          newTiles: n === 0 ? known.length : 0,
          credits: paid.total,
          clean: paid.clean,
          assistBonus: paid.assistBonus,
          mannerBonus: paid.mannerBonus,
          excluded: 0,
          capReached: false,
          rejected: false,
        };
      });
      await prisma.$transaction([
        prisma.tileVisit.createMany({ data: visits, skipDuplicates: true }),
        // 다른 차가 이미 가진 칸은 건너뛴다(땅 한 칸에 주인 하나).
        prisma.ownedTile.createMany({ data: owned, skipDuplicates: true }),
        // 아래 지난 출근길 기록 5번(모두 80점 초과)을 칸별 주행 수에도 넣는다.
        prisma.tileRecord.createMany({
          data: known.map((id) => ({
            vehicleId,
            ...parseTileId(id),
            goodTrips: scores.filter(isGoodTrip).length,
            lastPassedAt: trips[trips.length - 1].endedAt,
          })),
        }),
        prisma.vehicleTrip.createMany({ data: trips }),
        prisma.vehicle.update({ where: { id: vehicleId }, data: { credits: 120, safeStreak: 4, bestSafeStreak: 5 } }),
        prisma.creditLedger.create({ data: { vehicleId, amount: 120 - RULES.welcomeCredits, kind: "WELCOME", refId: "demo-seed" } }),
      ]);
    });
    await this.game.refreshLand(vehicleId);
    return this.game.home(vehicleId);
  }

  async remove(vehicleId: string) {
    await this.ensure(vehicleId);
    const day = seoulDay(await this.clock.now(vehicleId));
    await this.auth.forgetVehicle(vehicleId);
    await prisma.vehicle.delete({ where: { id: vehicleId } });
    await this.clock.reset(vehicleId);
    await this.ranking.remove(vehicleId, day);
    return { removed: true };
  }

  /** 시연 스크립트가 에뮬레이터 GPS 로 흘려 보낼 출근길 좌표. */
  route() {
    return { points: sampleRoute(COMMUTE, 25).map(([lat, lng]) => ({ lat, lng })) };
  }

  private async ensure(vehicleId: string) {
    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true } });
    if (!v) throw new NotFoundException("없는 차량이에요");
  }
}
