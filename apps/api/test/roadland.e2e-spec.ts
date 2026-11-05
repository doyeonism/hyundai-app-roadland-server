import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { prisma, prismaConnect, prismaDisconnect } from "@template/database";
import type {
  CarHomeResponse,
  CarRankingResponse,
  CollectResponse,
  LandTileView,
  RegisterDeviceResponse,
  SubmitTripRequest,
  TerritoryResponse,
  TripResult,
} from "@template/shared";

import { AppModule } from "../src/shared/modules/app.module";
import { setupApplication } from "../src/shared/configs/app.setup";
import { RedisService } from "../src/shared/redis/redis.service";
import { routeTiles, COMMUTE } from "../src/roadland/domain/places";
import { RULES } from "../src/roadland/domain/rules";

const CAR = `/api/${process.env.PROJECT_NAME}/v1/car`;

type Body<T> = { result: boolean; message: string; data: T };

describe("Roadland car API (e2e)", () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;
  let token = "";
  let vehicleId = "";
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const commute = routeTiles(COMMUTE).slice(0, 10);

  const trip = (o: Partial<SubmitTripRequest> = {}): SubmitTripRequest => {
    const ended = new Date(Date.now() - 60_000);
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

  it("지나간 땅을 사고, 크레딧이 모자라면 안내 문구로 거절한다", async () => {
    const before = await get<CarHomeResponse>("/home");
    const tile = await post<LandTileView>(`/tiles/${commute[0]}/buy`);
    expect(tile.owned).toBe(true);
    expect(tile.level).toBe(1);
    const after = await get<CarHomeResponse>("/home");
    expect(after.credits).toBe(before.credits - RULES.buyBaseCost);

    await request(server()).post(`${CAR}/tiles/1:1/buy`).set(auth()).expect(400);
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { credits: 0 } });
    const res = await request(server()).post(`${CAR}/tiles/${commute[1]}/buy`).set(auth()).expect(400);
    expect((res.body as Body<unknown>).message).toBe("크레딧이 부족해요");
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { credits: 500 } });
  });

  it("같은 땅을 동시에 사도 한 번만 산다", async () => {
    const id = commute[2];
    const codes = await Promise.all(
      [0, 1, 2].map(async () => (await request(server()).post(`${CAR}/tiles/${id}/buy`).set(auth())).status),
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    const territory = await get<TerritoryResponse>("/territory");
    expect(territory.tiles.filter((t) => t.owned)).toHaveLength(2);
  });

  it("시간이 지나면 방치 수익이 쌓이고, 업그레이드는 쌓인 수익을 먼저 준다", async () => {
    await request(server()).post(`${CAR}/dev/vehicles/${vehicleId}/advance`).send({ hours: 2 }).expect(200);
    const home = await get<CarHomeResponse>("/home");
    expect(home.pendingIncome).toBe(2 * 2 * RULES.incomePerLevel);

    const before = home.credits;
    const tile = await post<LandTileView>(`/tiles/${commute[0]}/upgrade`);
    expect(tile.level).toBe(2);
    expect(tile.pending).toBe(0);
    const after = await get<CarHomeResponse>("/home");
    expect(after.credits).toBe(before + 2 * RULES.incomePerLevel - RULES.upgradeCostPerLevel);

    await request(server()).post(`${CAR}/dev/vehicles/${vehicleId}/advance`).send({ hours: 24 }).expect(200);
    const c = await post<CollectResponse>("/collect");
    expect(c.collected).toBe(RULES.idleCapHours * (2 + 1) * RULES.incomePerLevel);
    expect((await get<CarHomeResponse>("/home")).pendingIncome).toBe(0);
  });

  it("랭킹은 Redis 에서 땅 점수와 주간 주행 크레딧을 보여 준다", async () => {
    const r = await get<CarRankingResponse>("/ranking");
    expect(r.land.mine).toMatchObject({ rank: 1, score: 3, me: true });
    expect(r.weekly.mine?.score).toBeGreaterThan(0);
  });

  it("서버에서 지운 차량의 토큰은 바로 막힌다", async () => {
    await request(server()).delete(`${CAR}/dev/vehicles/${vehicleId}`).expect(200);
    await request(server()).get(`${CAR}/home`).set(auth()).expect(401);
  });
});
