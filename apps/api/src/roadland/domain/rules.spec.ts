import type { SubmitTripRequest, TileSegment } from "@template/shared";

import { hexDistance, tileForLatLng } from "./hex";
import {
  buyCost,
  daysAgo,
  incomePerHour,
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
  [37.5446, 127.0559, "44406:20068"],
  [37.4979, 127.0276, "44408:20039"],
  [35.1796, 129.0756, "45997:18615"],
  [0, 0, "0:0"],
  [-33.8688, 151.2093, "73702:-17827"],
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
  it("최근 7일 중 3일 이상 지나간 타일은 홈 루트이고 수익이 더 크다", () => {
    const home = { level: 2, visitDays: [daysAgo(today, 1), daysAgo(today, 3), today] };
    const plain = { level: 2, visitDays: [daysAgo(today, 1)] };
    const old = { level: 2, visitDays: [daysAgo(today, 8), daysAgo(today, 9), daysAgo(today, 10)] };
    expect(isHomeRoute(home, today)).toBe(true);
    expect(isHomeRoute(old, today)).toBe(false);
    expect(incomePerHour(home, today)).toBeGreaterThan(incomePerHour(plain, today));
  });

  it("방치 수익은 상한 시간까지만 쌓인다", () => {
    const now = new Date("2026-11-02T12:00:00+09:00");
    const tile = (h: number) => ({ level: 1, visitDays: [], collectedAt: new Date(now.getTime() - h * 3_600_000) });
    expect(pendingIncome(tile(2), now)).toBe(2 * RULES.incomePerLevel);
    expect(pendingIncome(tile(100), now)).toBe(pendingIncome(tile(RULES.idleCapHours), now));
    expect(pendingIncome({ level: 0, visitDays: [], collectedAt: null }, now)).toBe(0);
  });

  it("땅값은 가진 땅이 많을수록 오르고, 최고 레벨은 더 올릴 수 없다", () => {
    expect(buyCost(10)).toBeGreaterThan(buyCost(0));
    expect(upgradeCost(1)).toBe(RULES.upgradeCostPerLevel);
    expect(upgradeCost(RULES.maxTileLevel)).toBeNull();
  });

  it("주간 랭킹은 서울 기준 월요일에 바뀐다", () => {
    expect(seoulWeek("2026-11-02")).toBe("2026-11-02"); // 월
    expect(seoulWeek("2026-11-08")).toBe("2026-11-02"); // 일
    expect(seoulWeek("2026-11-09")).toBe("2026-11-09");
  });
});
