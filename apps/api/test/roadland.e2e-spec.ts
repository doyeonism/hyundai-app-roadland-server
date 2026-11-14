import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { prisma, prismaConnect, prismaDisconnect } from "@loadland/database";
import type {
  CarHomeResponse,
  CarRankingResponse,
  CollectResponse,
  LandTileView,
  RegisterDeviceResponse,
  SubmitTripRequest,
  TerritoryResponse,
  TripResult,
} from "@loadland/shared";

import { AppModule } from "../src/shared/modules/app.module";
import { setupApplication } from "../src/shared/configs/app.setup";
import { RedisService } from "../src/shared/redis/redis.service";
import { routeTiles, COMMUTE } from "../src/roadland/domain/places";
import { PrivacyService } from "../src/roadland/services/privacy.service";
import { VehicleLockService } from "../src/roadland/services/vehicle-lock.service";
import { devToolsEnabled } from "../src/roadland/services/clock.service";
import { DevToolsGuard } from "../src/roadland/guards/vehicle.guard";
import { RULES, incomePerDay, seoulDay, daysAgo } from "../src/roadland/domain/rules";

const CAR = `/api/${process.env.PROJECT_NAME}/v1/car`;

type Body<T> = { result: boolean; message: string; data: T };

describe("Roadland car API (e2e)", () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;
  let token = "";
  let vehicleId = "";
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const commute = routeTiles(COMMUTE).slice(0, 10);

  let tripIndex = 0;
  const trip = (o: Partial<SubmitTripRequest> = {}): SubmitTripRequest => {
    const ended = new Date(Date.now() - 60_000 - tripIndex++ * 30 * 60_000);
    return {
      clientTripId: `trip-${Math.random()}`,
      startedAt: new Date(ended.getTime() - 20 * 60_000).toISOString(),
      endedAt: ended.toISOString(),
      km: 3,
      safetyScore: 95,
      hardBrakes: 0,
      warnings: 0,
      laneChanges: 2,
      signaledLaneChanges: 2,
      tiles: commute.map((id) => ({ id, hardBrake: false, warning: false, assisted: false })),
      ...o,
    };
  };

  const get = async <T>(path: string) =>
    ((await request(server()).get(`${CAR}${path}`).set(auth()).expect(200)).body as Body<T>).data;
  const post = async <T>(path: string, body: object = {}, status = 200) =>
    ((await request(server()).post(`${CAR}${path}`).set(auth()).send(body).expect(status)).body as Body<T>).data;

  beforeAll(async () => {
    if (!(process.env.DATABASE_URL ?? "").includes("template_test")) {
      throw new Error("[e2e] DATABASE_URL 이 테스트 DB(template_test)가 아니라 중단합니다.");
    }
    process.env.ROADLAND_DEV_TOOLS = "true";
    await prismaConnect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApplication(app);
    await app.init();
    await prisma.vehicle.deleteMany();
    await app.get(RedisService).raw.flushdb();

    const res = await request(server()).post(`${CAR}/devices`).expect(201);
    ({ token, vehicleId } = (res.body as Body<RegisterDeviceResponse>).data);
    await post("/privacy/consent", {version: "2026-11-14"});
  });

  afterAll(async () => {
    await prisma.vehicle.deleteMany();
    await app.close();
    await prismaDisconnect();
  });

  it("토큰이 없거나 모르는 토큰이면 401", async () => {
    await request(server()).get(`${CAR}/home`).expect(401);
    await request(server()).get(`${CAR}/home`).set({ Authorization: "Bearer nope" }).expect(401);
  });

  it("등록하면 환영 크레딧으로 시작한다", async () => {
    const home = await get<CarHomeResponse>("/home");
    expect(home.credits).toBe(RULES.welcomeCredits);
    expect(home.personalLevel).toBe(1);
    expect(home.personalUpgradeCost).toBe(800);
    expect(home.ownedTiles).toBe(0);
    expect(home.latestTrip).toBeNull();
  });

  it("주행을 정산하고, 같은 clientTripId 를 동시에·다시 보내도 한 번만 정산한다", async () => {
    const body = trip({ clientTripId: "dup-1" });
    const results = await Promise.all([0, 1, 2].map(() => post<TripResult>("/trips", body, 201)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const t = results[0];
    expect(t.newTiles).toBe(commute.length);
    expect(t.credits).toBe(t.breakdown.clean + t.breakdown.mannerBonus);

    const again = await post<TripResult>("/trips", body, 201);
    expect(again.id).toBe(t.id);
    const home = await get<CarHomeResponse>("/home");
    expect(home.credits).toBe(RULES.welcomeCredits + t.credits);
    expect(home.today.trips).toBe(1);
    expect(home.today.tileIds).toHaveLength(commute.length);
    expect(home.buyableTiles).toBeGreaterThanOrEqual(commute.length);
    // 주간 랭킹은 시계를 앞당기기 전에 본다(앞당기면 다음 주로 넘어갈 수 있다).
    const r = await get<CarRankingResponse>("/ranking");
    expect(r.weekly.mine?.score).toBe(t.credits);
  });

  it("비현실적인 기록은 저장하지만 보상하지 않는다", async () => {
    const t = await post<TripResult>("/trips", trip({ km: 500 }), 201);
    expect(t.rejected).toBe(true);
    expect(t.credits).toBe(0);
  });

  it("형식이 틀린 기록은 400", async () => {
    await request(server())
      .post(`${CAR}/trips`)
      .set(auth())
      .send({ ...trip(), tiles: [{ id: "bad", hardBrake: false, warning: false, assisted: false }] })
      .expect(400);
  });

  it("지나간 빈 땅을 100에 사고, 크레딧이 모자라면 안내 문구로 거절한다", async () => {
    const before = await get<CarHomeResponse>("/home");
    const tile = await post<LandTileView>(`/tiles/${commute[0]}/buy`);
    expect(tile.owned).toBe(true);
    expect(tile.level).toBe(1);
    expect(tile.price).toBe(RULES.buyBaseCost);
    expect(tile.goodTrips).toBe(1); // 95점 주행 한 번(거부된 주행은 세지 않음)
    const after = await get<CarHomeResponse>("/home");
    expect(after.credits).toBe(before.credits - RULES.buyBaseCost);

    await request(server()).post(`${CAR}/tiles/1:1/buy`).set(auth()).expect(400);
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { credits: 0 } });
    const res = await request(server()).post(`${CAR}/tiles/${commute[1]}/buy`).set(auth()).expect(400);
    expect((res.body as Body<unknown>).message).toBe("크레딧이 부족해요");
    const levelBefore = (await get<TerritoryResponse>("/territory")).tiles.find(t => t.id === commute[0])!.level;
    await request(server()).post(`${CAR}/profile/upgrade`).set(auth()).send({expectedLevel: 1}).expect(400);
    expect((await get<CarHomeResponse>("/home")).credits).toBe(0);
    expect((await get<TerritoryResponse>("/territory")).tiles.find(t => t.id === commute[0])!.level).toBe(levelBefore);
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { credits: 50000 } });
  });

  it("같은 땅을 동시에 사도 한 번만 사고, 빈 땅값은 가진 땅마다 100씩 오른다", async () => {
    const id = commute[2];
    const codes = await Promise.all(
      [0, 1, 2].map(async () => (await request(server()).post(`${CAR}/tiles/${id}/buy`).set(auth())).status),
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    const territory = await get<TerritoryResponse>("/territory");
    expect(territory.tiles.filter((t) => t.owned)).toHaveLength(2);
    const next = territory.tiles.find((t) => !t.owned && !t.ownedByOther && t.buyCost !== null)!;
    expect(next.buyCost).toBe(RULES.buyBaseCost * 3); // 두 칸을 가졌으니 세 번째는 15
  });

  // 레벨 1의 시간당 환산 수익.
  const rate = RULES.dailyLandBase / 24;

  it("하루 수익은 레벨마다 1 증가하며 업그레이드 비용을 차감한다", async () => {
    await request(server()).post(`${CAR}/dev/vehicles/${vehicleId}/advance`).send({ hours: 2 }).expect(200);
    const home = await get<CarHomeResponse>("/home");
    expect(home.incomePerHour).toBe(2 * rate);
    expect(home.pendingIncome).toBe(2 * 2 * rate); // 두 칸 × 2시간

    const before = home.credits;
    const replies = await Promise.all([0, 1, 2].map(() => request(server()).post(`${CAR}/profile/upgrade`).set(auth()).send({expectedLevel: 1})));
    expect(replies.filter(r => r.status === 200)).toHaveLength(1);
    expect(replies.filter(r => r.status === 409)).toHaveLength(2);
    const profile = (replies.find(r => r.status === 200)!.body as Body<CarHomeResponse>).data;
    expect(profile.personalLevel).toBe(2);
    expect(profile.incomePerTilePerDay).toBe(2401);
    expect(profile.nextIncomePerTilePerDay).toBe(2402);
    const owned = (await get<TerritoryResponse>("/territory")).tiles.filter(t => t.owned);
    expect(owned.every(t => t.incomePerDay === 2401 && t.upgradeCost === null)).toBe(true);
    expect(owned.every(t => t.pending === 0)).toBe(true);
    await request(server()).post(`${CAR}/tiles/${commute[0]}/upgrade`).set(auth()).expect(400);
    const after = await get<CarHomeResponse>("/home");
    expect(after.credits).toBe(before + 4 * rate - RULES.upgradeCostBase);

    await request(server()).post(`${CAR}/dev/vehicles/${vehicleId}/advance`).send({ hours: 24 }).expect(200);
    const c = await post<CollectResponse>("/collect");
    expect(c.collected).toBe(2 * incomePerDay({level: 2}));
    expect((await get<CarHomeResponse>("/home")).pendingIncome).toBe(0);
  });

  it("땅 랭킹은 소유한 칸 수로 보여 준다", async () => {
    const r = await get<CarRankingResponse>("/ranking");
    expect(r.land.mine).toMatchObject({ rank: 1, score: 2, me: true });
  });

  it("다른 차는 내 땅을 거래가 + 100에 빼앗고, 나는 쌓인 수익을 받은 뒤 땅이 레벨 1로 넘어간다", async () => {
    const reg = await request(server()).post(`${CAR}/devices`).expect(201);
    const other = (reg.body as Body<RegisterDeviceResponse>).data;
    await request(server()).post(`${CAR}/privacy/consent`).set({Authorization: `Bearer ${other.token}`}).send({version: "2026-11-14"}).expect(200);
    const as = (t: string) => ({ Authorization: `Bearer ${t}` });
    const target = commute[0]; // 내 땅, 레벨 2, 거래가 5

    // 지나가지 않은 땅은 못 산다.
    await request(server()).post(`${CAR}/tiles/${target}/buy`).set(as(other.token)).expect(400);
    // 내가 산 뒤에 지나간 주행이어야 한다(종료 시각이 거래 뒤).
    await request(server()).post(`${CAR}/trips`).set(as(other.token)).send(trip({ endedAt: new Date().toISOString() })).expect(201);

    // 내 시계를 1시간 앞당겨 그 땅에 수익을 쌓아 둔다.
    await request(server()).post(`${CAR}/dev/vehicles/${vehicleId}/advance`).send({ hours: 1 }).expect(200);
    const mineBefore = await get<CarHomeResponse>("/home");

    const bought = await request(server()).post(`${CAR}/tiles/${target}/buy`).set(as(other.token)).expect(200);
    const tile = (bought.body as Body<LandTileView>).data;
    expect(tile).toMatchObject({ owned: true, level: 1, price: RULES.buyBaseCost + RULES.buyRaise });
    const otherHome = (await request(server()).get(`${CAR}/home`).set(as(other.token)).expect(200)).body as Body<CarHomeResponse>;
    expect(otherHome.data.credits).toBe(RULES.welcomeCredits + otherHome.data.latestTrip!.credits - 200);

    // 나는 그 땅(레벨 2)에 쌓인 1시간 수익을 받고, 땅은 다른 차 것으로 보인다.
    const mineAfter = await get<CarHomeResponse>("/home");
    expect(mineAfter.credits).toBe(mineBefore.credits + Math.floor(incomePerDay({level: 2}) / 24));
    const view = (await get<TerritoryResponse>("/territory")).tiles.find((t) => t.id === target)!;
    // 예전에 지나간 기록은 거래 전이라 다시 지나가야 살 수 있다.
    expect(view).toMatchObject({ owned: false, ownedByOther: true, level: 0, price: 200, buyCost: null, mustRevisit: true });
    const refused = await request(server()).post(`${CAR}/tiles/${target}/buy`).set(auth()).expect(400);
    expect((refused.body as Body<unknown>).message).toBe("주인이 바뀐 뒤에 다시 지나가야 살 수 있어요");
    await post<TripResult>("/trips", trip(), 201);
    const again = (await get<TerritoryResponse>("/territory")).tiles.find((t) => t.id === target)!;
    expect(again).toMatchObject({ mustRevisit: false, buyCost: 300 });

    // 다시 빼앗으면 15. 낸 돈은 누구에게도 가지 않는다.
    const otherBefore = otherHome.data.credits;
    const back = await post<LandTileView>(`/tiles/${target}/buy`);
    expect(back).toMatchObject({ owned: true, level: 2, price: 300, incomePerDay: 2401 });
    const otherAfter = (await request(server()).get(`${CAR}/home`).set(as(other.token)).expect(200)).body as Body<CarHomeResponse>;
    expect(otherAfter.data.credits).toBe(otherBefore); // 방금 산 땅이라 쌓인 수익 없음
    const r = await get<CarRankingResponse>("/ranking");
    expect(r.land.mine?.score).toBe(2); // 레벨 1 두 칸
  });

  it("최고 개인 레벨과 잘못된 요청은 결제 없이 거절한다", async () => {
    const before = (await get<CarHomeResponse>("/home")).credits;
    await prisma.vehicle.update({where: {id: vehicleId}, data: {personalLevel: 60}});
    const home = await get<CarHomeResponse>("/home");
    expect(home.personalUpgradeCost).toBeNull();
    expect(home.incomePerTilePerDay).toBe(2459);
    await request(server()).post(`${CAR}/profile/upgrade`).set(auth()).send({expectedLevel: 60}).expect(400);
    await request(server()).post(`${CAR}/profile/upgrade`).set(auth()).send({expectedLevel: -1}).expect(400);
    await request(server()).post(`${CAR}/profile/upgrade`).set(auth()).send({}).expect(400);
    expect((await get<CarHomeResponse>("/home")).credits).toBe(before);
  });

  it("동의 전에는 주행 수집을 거절하고, 동의를 기록한다", async () => {
    const reg = (await request(server()).post(`${CAR}/devices`).expect(201)).body.data as RegisterDeviceResponse;
    const headers = {Authorization: `Bearer ${reg.token}`};
    await request(server()).post(`${CAR}/trips`).set(headers).send(trip()).expect(403);
    await request(server()).post(`${CAR}/privacy/consent`).set(headers).send({version: "old"}).expect(400);
    await request(server()).post(`${CAR}/privacy/consent`).set(headers).send({version: "2026-11-14"}).expect(200);
    const row = await prisma.vehicle.findUniqueOrThrow({where: {id: reg.vehicleId}});
    expect(row.consentedAt).not.toBeNull();
    await request(server()).delete(`${CAR}/profile`).set(headers).expect(200);
    await request(server()).get(`${CAR}/home`).set(headers).expect(401);
  });

  it("Redis 잠금이 사라져도 DB 잠금으로 겹친 주행은 한 번만 보상한다", async () => {
    const body = trip();
    // Simulate an expired Redis lease: DB row locking must still serialize writes.
    const bypass = jest.spyOn(app.get(VehicleLockService), "run").mockImplementation(async (_id, work) => work());
    try {
      const replies = await Promise.all([0, 1].map(i => post<TripResult>("/trips", {...body, clientTripId: `overlap-${i}`}, 201)));
      expect(replies.filter(t => !t.rejected)).toHaveLength(1);
      expect(replies.find(t => t.rejected)?.rejectReason).toBe("overlap");
      expect(replies.every(t => t.rulesVersion === "2026-11-14-v1")).toBe(true);
      const ledgers = await prisma.creditLedger.findMany({where: {refId: {in: replies.map(t => t.id)}, kind: "TRIP"}});
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0].day).not.toBeNull();
    } finally { bypass.mockRestore(); }
  });

  it("일일 한도는 정산 날짜별 원장을 사용한다", async () => {
    const body = trip();
    const clockOffset = Number(await app.get(RedisService).get(`rl:clock:${vehicleId}`)) || 0;
    const day = seoulDay(new Date(new Date(body.endedAt).getTime() + clockOffset));
    const sum = await prisma.creditLedger.aggregate({where: {vehicleId, day, kind: "TRIP"}, _sum: {amount: true}});
    await prisma.creditLedger.create({data: {vehicleId, kind: "TRIP", day, amount: RULES.dailyDriveCap - (sum._sum.amount ?? 0), refId: "cap-fixture"}});
    const result = await post<TripResult>("/trips", body, 201);
    expect(result.rejected).toBe(false);
    expect(result.credits).toBe(0);
    expect(result.capReached).toBe(true);
  });

  it("90일 경로와 7일 방문 날짜를 지워도 중복 방지와 구매 자격은 남는다", async () => {
    const ended = new Date(Date.now() - 91 * 86_400_000);
    const body = trip({clientTripId: "retention-trip", startedAt: new Date(ended.getTime() - 20 * 60_000).toISOString(), endedAt: ended.toISOString()});
    const t = await post<TripResult>("/trips", body, 201);
    expect(t.rejected).toBe(false);
    await prisma.tileVisit.create({data: {vehicleId, q: 123, r: 456, day: daysAgo(seoulDay(new Date()), 8)}});
    await prisma.tileRecord.create({data: {vehicleId, q: 123, r: 456, goodTrips: 1, lastPassedAt: null}});
    await app.get(PrivacyService).cleanup();
    expect(await prisma.tileVisit.count({where: {vehicleId, q: 123, r: 456}})).toBe(0);
    const stored = await prisma.vehicleTrip.findUniqueOrThrow({where: {id: t.id}});
    expect(stored.tiles).toEqual([]);
    const replay = await post<TripResult>("/trips", body, 201);
    expect(replay.id).toBe(t.id);
    const eligible = (await get<TerritoryResponse>("/territory")).tiles.find(x => x.id === "123:456");
    expect(eligible).toBeDefined();
    expect(eligible!.buyCost).not.toBeNull();
  });

  it("운영에서는 개발 시계와 도구가 강제로 차단되고 스테이징은 키를 요구한다", () => {
    const original = process.env.NODE_ENV;
    const key = process.env.ROADLAND_DEV_TOKEN;
    try {
      process.env.NODE_ENV = "production";
      expect(devToolsEnabled()).toBe(false);
      expect(() => new DevToolsGuard().canActivate({} as never)).toThrow();
      process.env.NODE_ENV = "staging";
      delete process.env.ROADLAND_DEV_TOKEN;
      expect(() => new DevToolsGuard().canActivate({} as never)).toThrow();
      process.env.ROADLAND_DEV_TOKEN = "test-only-key";
      const context = {switchToHttp: () => ({getRequest: () => ({headers: {"x-roadland-dev-token": "wrong"}})})};
      expect(() => new DevToolsGuard().canActivate(context as never)).toThrow();
    } finally {
      if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original;
      if (key === undefined) delete process.env.ROADLAND_DEV_TOKEN; else process.env.ROADLAND_DEV_TOKEN = key;
    }
  });

  it("차량별 요청 한도를 넘으면 429를 반환한다", async () => {
    const redis = app.get(RedisService);
    const key = `roadland:rate:${vehicleId}:${Math.floor(Date.now() / 60_000)}`;
    await redis.set(key, "90", 120);
    await request(server()).get(`${CAR}/home`).set(auth()).expect(429);
    await redis.del(key);
  });

  it("서버에서 지운 차량의 토큰은 바로 막힌다", async () => {
    await request(server()).delete(`${CAR}/profile`).set(auth()).expect(200);
    await request(server()).get(`${CAR}/home`).set(auth()).expect(401);
    expect(await prisma.vehicleTrip.count({where: {vehicleId}})).toBe(0);
    expect(await prisma.creditLedger.count({where: {vehicleId}})).toBe(0);
    expect(await prisma.tileVisit.count({where: {vehicleId}})).toBe(0);
    expect(await prisma.tileRecord.count({where: {vehicleId}})).toBe(0);
    expect(await prisma.ownedTile.count({where: {vehicleId}})).toBe(0);
  });
});
