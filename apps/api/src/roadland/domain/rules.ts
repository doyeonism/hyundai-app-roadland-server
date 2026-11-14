import type { SubmitTripRequest } from "@loadland/shared";

import { hexDistance } from "./hex";

// 게임 수치. 밸런스를 바꿀 때는 이 파일만 고친다. 차량 앱의 주행 중 예상 크레딧(Rules.kt)도 같은 값을 쓴다.
export const RULES = {
  /** 처음 등록한 차량에 주는 크레딧. 첫 땅 하나를 바로 살 수 있게. */
  welcomeCredits: 2000,
  /** 안전하게 지나간 타일 한 칸(약 10m)의 크레딧. 1km에 대략 60~80칸. */
  tileCredit: 40,
  /** 에코 모드·크루즈로 지나간 타일의 추가 비율. */
  assistBonus: 0.5,
  /** 차선 변경 때 깜빡이 사용률이 이 이상이면 매너 보너스. */
  mannerSignalRate: 0.8,
  mannerBonus: 0.2,
  /** 하루 주행으로 받는 크레딧 상한. 오래 달리는 것이 최적 전략이 되지 않게 한다. */
  dailyDriveCap: 8000,
  /** 주인 없는 땅의 값 = 이 값 × (내가 가진 땅 수 + 1). 첫 땅은 100, 땅이 늘수록 비싸져 끝없이 불어나지 않게 한다. */
  buyBaseCost: 100,
  /** 주인 있는 땅은 마지막 거래가보다 이만큼 더 내야 산다. 낸 돈은 누구에게도 가지 않는다. */
  buyRaise: 100,
  /** 업그레이드 값 = upgradeCostBase × upgradeCostGrowth^(지금 레벨 − 1). 레벨 1→2는 800, 높을수록 가파르게 비싸진다. */
  upgradeCostBase: 800,
  upgradeCostGrowth: 1.15,
  maxTileLevel: 60,
  /** 하루 기본 수익은 종전 시간당 기본값 5 × 24시간 × 20. 레벨마다 하루 +1. */
  dailyLandBase: 2400,
  dailyLandLevelBonus: 1,
  incomeGoodScore: 80, // 방문 기록 통계에만 사용, 땅 수익과 무관
  /** 최근 7일 중 이 일수 이상 지나간 타일은 홈 루트(자주 다니는 길 표시). */
  homeRouteDays: 3,
  /** 방치 수익이 쌓이는 최대 시간. 정기적인 탑승과 수령을 유도한다. */
  idleCapHours: 24,
  /** 안전 연속 기록으로 치는 점수. */
  safeStreakScore: 90,
  /** 기록 검증: 이보다 빠른 평균 속도나 거리 대비 너무 많은 타일은 보상하지 않는다. */
  maxAvgKph: 200,
  maxTilesPerKm: 150,
  /** 이어지는 두 타일 사이가 이 칸 수보다 멀면 위치가 튄 것으로 본다. 이런 구간이 많으면 거부. */
  maxStepTiles: 3,
  maxJumps: 2,
  /** 한 번에 받는 타일 수 상한(요청 크기 제한). 10m 타일로 약 200km. */
  maxTilesPerTrip: 20000,
} as const;

const HOUR = 3_600_000;

export interface TileState {
  id: string;
  visitDays: string[];
  level: number;
  collectedAt: Date | null;
  /** 내가 이 칸을 지나간 주행 중 안전 점수 기준을 넘은 수와 넘지 못한 수. */
  goodTrips: number;
  badTrips: number;
}

/** 서울 기준 날짜 YYYY-MM-DD. */
export function seoulDay(at: Date | string) {
  return new Date(at).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

export function daysAgo(day: string, n: number) {
  const d = new Date(`${day}T00:00:00+09:00`);
  return seoulDay(new Date(d.getTime() - n * 24 * HOUR));
}

/** 이 날짜가 속한 주의 월요일(서울). 주간 랭킹 키에 쓴다. */
export function seoulWeek(day: string) {
  const weekday = new Date(`${day}T12:00:00+09:00`).getUTCDay(); // 서울 정오는 UTC 같은 날
  return daysAgo(day, (weekday + 6) % 7);
}

/** 보상하지 않을 주행이면 이유, 아니면 null. */
export function rejectReason(t: SubmitTripRequest): string | null {
  const hours = (new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime()) / HOUR;
  if (!(hours > 0) || t.km < 0) return "time";
  if (t.km / hours > RULES.maxAvgKph) return "speed";
  if (t.tiles.length > t.km * RULES.maxTilesPerKm + 3) return "density";
  if (t.safetyScore < 0 || t.safetyScore > 100) return "score";
  let jumps = 0;
  for (let i = 1; i < t.tiles.length; i++) {
    if (hexDistance(t.tiles[i - 1].id, t.tiles[i].id) > RULES.maxStepTiles) jumps++;
  }
  if (jumps > RULES.maxJumps) return "continuity";
  return null;
}

/** 일일 상한 적용 전 이번 주행의 크레딧. 같은 타일을 여러 번 지나도 한 번만 친다. */
export function tripCredits(t: Pick<SubmitTripRequest, "tiles" | "laneChanges" | "signaledLaneChanges">) {
  const seen = new Set<string>();
  let clean = 0;
  let assistBonus = 0;
  let excluded = 0;
  for (const s of t.tiles) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    if (s.hardBrake || s.warning) {
      excluded++;
      continue;
    }
    clean += RULES.tileCredit;
    if (s.assisted) assistBonus += RULES.tileCredit * RULES.assistBonus;
  }
  const mannered = t.laneChanges > 0 && t.signaledLaneChanges / t.laneChanges >= RULES.mannerSignalRate;
  const mannerBonus = mannered ? Math.round((clean + assistBonus) * RULES.mannerBonus) : 0;
  return {
    clean,
    assistBonus: Math.round(assistBonus),
    mannerBonus,
    excluded,
    total: clean + Math.round(assistBonus) + mannerBonus,
  };
}

export function isHomeRoute(tile: Pick<TileState, "visitDays">, today: string) {
  const since = daysAgo(today, 6);
  return tile.visitDays.filter((d) => d >= since && d <= today).length >= RULES.homeRouteDays;
}

/** 방문 기록의 안전 점수 분류. 땅 수익에는 영향을 주지 않는다. */
export function isGoodTrip(safetyScore: number) {
  return safetyScore > RULES.incomeGoodScore;
}

/** 같은 레벨이면 방문 기록과 관계없이 동일한 하루 수익. */
export function incomePerDay(tile: Pick<TileState, "level">) {
  if (tile.level <= 0) return 0;
  return RULES.dailyLandBase + (Math.min(tile.level, RULES.maxTileLevel) - 1) * RULES.dailyLandLevelBonus;
}

/** 기존 클라이언트 호환용 시간당 환산값. 실제 지급은 하루 수익으로 계산한다. */
export function incomePerHour(tile: Pick<TileState, "level">) {
  return incomePerDay(tile) / 24;
}

/** 최대 24시간까지 적립. 정수 크레딧만 지급하고 나머지 시간은 수령 시 보존. */
export function pendingIncome(tile: Pick<TileState, "level" | "goodTrips" | "badTrips" | "collectedAt">, now: Date) {
  if (!tile.collectedAt) return 0;
  const elapsed = Math.min(Math.max(0, now.getTime() - tile.collectedAt.getTime()), RULES.idleCapHours * HOUR);
  return Math.floor(incomePerDay(tile) * elapsed / (24 * HOUR));
}

export function collectedUntil(collectedAt: Date, now: Date, tile: Pick<TileState, "level">) {
  const elapsed = Math.max(0, now.getTime() - collectedAt.getTime());
  if (elapsed >= RULES.idleCapHours * HOUR) return now;
  const rate = incomePerDay(tile);
  if (rate === 0) return collectedAt;
  const paid = Math.floor(rate * elapsed / (24 * HOUR));
  return new Date(collectedAt.getTime() + Math.ceil(paid * 24 * HOUR / rate));
}

/**
 * 살 때 내는 값. 주인 없는 땅은 기본값 × (내가 가진 땅 + 1), 주인 있는 땅은 마지막 거래가 + 인상분.
 * @param ownedCount 사는 차가 지금 가진 땅 수
 */
export function buyCost(lastPrice: number | null, ownedCount: number) {
  return lastPrice === null ? RULES.buyBaseCost * (ownedCount + 1) : lastPrice + RULES.buyRaise;
}

export function upgradeCost(level: number) {
  if (level < 1 || level >= RULES.maxTileLevel) return null;
  return 20 * Math.round((RULES.upgradeCostBase / 20) * RULES.upgradeCostGrowth ** (level - 1));
}
