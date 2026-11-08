// 로드랜드 차량 앱 ↔ 서버 계약 (v1/car/*). 차량 앱 CarApi.kt 가 같은 모양을 읽는다.

/** 차가 보내는 타일 한 칸의 주행 결과. 원본 좌표는 차 밖으로 나가지 않는다. */
export interface TileSegment {
  id: string; // "q:r"
  hardBrake: boolean; // 이 타일 안에서 급제동
  warning: boolean; // 이 타일 안에서 차량 안전 경고
  assisted: boolean; // 에코 모드 또는 크루즈 주행
}

export interface RegisterDeviceResponse {
  vehicleId: string;
  /** 이후 요청의 `Authorization: Bearer <token>`. 서버는 해시만 저장한다. */
  token: string;
}

export interface SubmitTripRequest {
  /** 차가 만든 주행 ID. 같은 ID를 다시 보내면 처음 정산 결과를 그대로 돌려준다. */
  clientTripId: string;
  startedAt: string;
  endedAt: string;
  km: number;
  safetyScore: number; // 0~100, 차 안에서 계산
  hardBrakes: number;
  warnings: number;
  laneChanges: number;
  signaledLaneChanges: number;
  tiles: TileSegment[];
}

export interface TripResult {
  id: string;
  clientTripId: string;
  endedAt: string;
  km: number;
  safetyScore: number;
  hardBrakes: number;
  warnings: number;
  laneChanges: number;
  signaledLaneChanges: number;
  tiles: TileSegment[];
  newTiles: number; // 처음 지나가 구매할 수 있게 된 타일
  credits: number; // 실제로 받은 크레딧(일일 상한 적용 뒤)
  breakdown: { clean: number; assistBonus: number; mannerBonus: number; excluded: number };
  capReached: boolean;
  rejected: boolean; // 기록 검증 실패로 보상 없음
}

export interface LandTileView {
  id: string;
  /** 지나간 날짜(YYYY-MM-DD, 서울 기준). */
  visitDays: string[];
  level: number; // 0이면 아직 사지 않은 땅
  collectedAt: string | null;
  /** 내 땅인지. */
  owned: boolean;
  /** 다른 차의 땅인지. 이 경우 buyCost 를 내면 빼앗을 수 있다. */
  ownedByOther: boolean;
  /** 마지막 거래가. 주인이 없으면 null. */
  price: number | null;
  homeRoute: boolean;
  /** 내가 이 칸을 지나간 주행 중 안전 점수 기준을 넘은 수와 넘지 못한 수. */
  goodTrips: number;
  badTrips: number;
  /** 1분마다 들어오는 크레딧. 레벨 × max(1, 5 + goodTrips − badTrips). */
  incomePerMinute: number;
  pending: number;
  buyCost: number | null; // 살 수 있으면 가격(주인 없으면 기본값, 있으면 거래가 + 인상분)
  upgradeCost: number | null; // 올릴 수 있으면 가격
}

export interface TerritoryResponse {
  tiles: LandTileView[];
}

export interface TodaySummary {
  trips: number;
  km: number;
  newTiles: number;
  tilesPassed: number;
  /** 주행 위젯이 이번 주행과 겹치는 타일을 빼고 셀 수 있게. */
  tileIds: string[];
  driveCredits: number;
  driveCap: number;
}

export interface CarHomeResponse {
  credits: number;
  pendingIncome: number;
  incomePerMinute: number;
  idleCapHours: number;
  ownedTiles: number;
  buyableTiles: number;
  today: TodaySummary;
  latestTrip: TripResult | null;
  safeStreak: number;
  now: string;
}

export interface CollectResponse {
  collected: number;
  credits: number;
}

export interface CarRecordsResponse {
  safeStreak: number; // 안전 점수 90점 이상 연속 주행
  bestSafeStreak: number;
  recentScores: number[];
  ownedTiles: number;
}

export interface RankingEntry {
  rank: number;
  name: string; // 익명 표시명
  score: number;
  me: boolean;
}

export interface RankingBoard {
  top: RankingEntry[];
  mine: RankingEntry | null;
}

export interface CarRankingResponse {
  /** 땅 점수(가진 땅 레벨 합). */
  land: RankingBoard;
  /** 이번 주(월요일 시작, 서울) 주행 크레딧. */
  weekly: RankingBoard;
}

export interface AdvanceClockRequest {
  hours: number;
}
