import type { SubmitTripRequest, TileSegment } from "@template/shared";

import { hexDistance, tileForLatLng } from "./hex";
import {
  buyCost,
  collectedUntil,
  daysAgo,
  incomePerHour,
  incomePerDay,
  isGoodTrip,
  isHomeRoute,
  pendingIncome,
  rejectReason,
  RULES,
  seoulWeek,
  tripCredits,
  upgradeCost,
} from "./rules";

// 차량 앱 HexGridTest.kt와 같은 값. 한쪽을 바꾸면 다른 쪽도 바꿔야 한다.
const VECTORS: [number, number, string][] = [
  [37.5446, 127.0559, "532866:240816"],
  [37.4979, 127.0276, "532896:240466"],
  [35.1796, 129.0756, "551970:223377"],
  [0, 0, "0:0"],
  [-33.8688, 151.2093, "884427:-213931"],
];

const seg = (id: string, o: Partial<TileSegment> = {}): TileSegment => ({
  id,
  hardBrake: false,
  warning: false,
  assisted: false,
  ...o,
});
const trip = (o: Partial<SubmitTripRequest> = {}): SubmitTripRequest => ({
  clientTripId: "t1",
  startedAt: "2026-11-02T00:00:00Z",
  endedAt: "2026-11-02T00:20:00Z",
  km: 8,
  safetyScore: 100,
  hardBrakes: 0,
  warnings: 0,
  laneChanges: 0,
  signaledLaneChanges: 0,
  tiles: [seg("1:1"), seg("1:2")],
  ...o,
});

describe("hex", () => {
  it("좌표를 차량 앱과 같은 타일로 바꾼다", () => {
    for (const [lat, lng, id] of VECTORS) expect(tileForLatLng(lat, lng)).toBe(id);
  });

  it("가까운 점은 같은 타일, 먼 점은 다른 타일", () => {
    expect(tileForLatLng(37.5446, 127.0559)).toBe(tileForLatLng(37.54461, 127.05591));
    expect(hexDistance(tileForLatLng(37.5446, 127.0559), tileForLatLng(37.4979, 127.0276))).toBeGreaterThan(20);
  });
});

describe("tripCredits", () => {
  it("안전하게 지나간 타일마다 크레딧, 같은 타일은 한 번만", () => {
    expect(tripCredits(trip({ tiles: [seg("1:1"), seg("1:2"), seg("1:1")] })).total).toBe(2 * RULES.tileCredit);
  });

  it("급제동·안전 경고가 있었던 타일은 보상에서 빠진다", () => {
    const c = tripCredits(trip({ tiles: [seg("1:1", { hardBrake: true }), seg("1:2", { warning: true }), seg("1:3")] }));
    expect(c).toMatchObject({ excluded: 2, clean: RULES.tileCredit, total: RULES.tileCredit });
  });

  it("에코·크루즈 구간은 보너스", () => {
    const c = tripCredits(trip({ tiles: [seg("1:1", { assisted: true })] }));
    expect(c.total).toBe(RULES.tileCredit * (1 + RULES.assistBonus));
  });

  it("깜빡이를 잘 켜면 매너 보너스, 안 켜면 없음", () => {
    expect(tripCredits(trip({ laneChanges: 5, signaledLaneChanges: 5 })).mannerBonus).toBeGreaterThan(0);
    expect(tripCredits(trip({ laneChanges: 5, signaledLaneChanges: 2 })).mannerBonus).toBe(0);
    expect(tripCredits(trip({ laneChanges: 0, signaledLaneChanges: 0 })).mannerBonus).toBe(0);
  });
});

describe("rejectReason", () => {
  it("정상 기록은 통과", () => expect(rejectReason(trip())).toBeNull());
  it("평균 속도가 비현실적이면 거절", () => expect(rejectReason(trip({ km: 300 }))).toBe("speed"));
  it("거리에 비해 타일이 너무 많으면 거절", () =>
    expect(rejectReason(trip({ km: 0.1, tiles: Array.from({ length: 50 }, (_, i) => seg(`0:${i}`)) }))).toBe("density"));
  it("끝난 시각이 시작보다 앞서면 거절", () => expect(rejectReason(trip({ endedAt: "2026-11-01T00:00:00Z" }))).toBe("time"));
  it("타일이 여러 번 멀리 튀면 거절, 한두 번은 봐준다", () => {
    const far = (n: number) => seg(`${n * 10}:0`);
    expect(rejectReason(trip({ tiles: [seg("0:0"), far(1)] }))).toBeNull();
    expect(rejectReason(trip({ km: 20, tiles: [far(0), far(1), far(2), far(3), far(4)] }))).toBe("continuity");
  });
});

describe("땅과 방치 수익", () => {
  const today = "2026-11-02";
  it("최근 7일 중 3일 이상 지나간 타일은 홈 루트", () => {
    expect(isHomeRoute({ visitDays: [daysAgo(today, 1), daysAgo(today, 3), today] }, today)).toBe(true);
    expect(isHomeRoute({ visitDays: [daysAgo(today, 8), daysAgo(today, 9), daysAgo(today, 10)] }, today)).toBe(false);
  });

  it("하루 기본 수익은 2400이며 레벨마다 정확히 1씩 오른다", () => {
    expect(incomePerDay({level: 0})).toBe(0);
    for (let level = 1; level <= 60; level++) {
      expect(incomePerDay({level})).toBe(2400 + level - 1);
    }
    expect(incomePerHour({level: 1})).toBe(100);
    expect(isGoodTrip(81)).toBe(true);
    expect(isGoodTrip(80)).toBe(false);
  });

  it("24시간 수익, 상한, 수령 후 잔여 시간과 중복 지급을 검증한다", () => {
    const start = new Date("2026-11-09T00:00:00Z");
    const tile = {level: 2, goodTrips: 0, badTrips: 999, collectedAt: start};
    const day = new Date(start.getTime() + 86400000);
    expect(pendingIncome(tile, day)).toBe(2401);
    expect(pendingIncome(tile, new Date(day.getTime() + 86400000))).toBe(2401);
    expect(pendingIncome({...tile, goodTrips: 999, badTrips: 0}, day)).toBe(2401);
    expect(pendingIncome(tile, new Date(start.getTime() - 1))).toBe(0);
    const now = new Date(start.getTime() + 1234567);
    const paid = pendingIncome(tile, now);
    const until = collectedUntil(start, now, tile);
    expect(pendingIncome({...tile, collectedAt: until}, now)).toBe(0);
    expect(paid + pendingIncome({...tile, collectedAt: until}, day)).toBeLessThanOrEqual(2401);
    expect(paid + pendingIncome({...tile, collectedAt: until}, day)).toBeGreaterThanOrEqual(2400);
    expect(collectedUntil(start, day, tile)).toEqual(day);
  });

  it("빈 땅은 100 × (가진 땅 + 1), 주인 있는 땅은 마지막 거래가 + 100", () => {
    expect(buyCost(null, 0)).toBe(100);
    expect(buyCost(null, 1)).toBe(200);
    expect(buyCost(null, 99)).toBe(10000);
    expect(buyCost(100, 0)).toBe(200); // 빼앗을 때는 가진 땅 수와 상관없다
    expect(buyCost(200, 50)).toBe(300);
  });

  it("업그레이드 값은 800에서 레벨마다 1.15배, 최고 레벨 60은 더 올릴 수 없다", () => {
    expect(upgradeCost(1)).toBe(800);
    expect(upgradeCost(2)).toBe(920);
    expect(upgradeCost(30)).toBe(20 * Math.round(40 * 1.15 ** 29));
    expect(upgradeCost(59)).toBe(2_651_940); // 1→60 전체는 약 100만
    expect(RULES.maxTileLevel).toBe(60);
    expect(upgradeCost(RULES.maxTileLevel)).toBeNull();
    expect(upgradeCost(0)).toBeNull();
  });

  it("주간 랭킹은 서울 기준 월요일에 바뀐다", () => {
    expect(seoulWeek("2026-11-02")).toBe("2026-11-02"); // 월
    expect(seoulWeek("2026-11-08")).toBe("2026-11-02"); // 일
    expect(seoulWeek("2026-11-09")).toBe("2026-11-09");
  });
});
