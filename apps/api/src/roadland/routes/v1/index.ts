export const CAR_ROUTES = {
  BASE: "v1/car",
  DEVICES: "devices", // POST: 기기 등록 → 토큰 발급 (공개)
  HOME: "home", // GET: 홈 요약
  TRIPS: "trips", // POST: 주행 정산 (clientTripId 로 중복 방지)
  TERRITORY: "territory", // GET: 지나간 땅·내 땅
  BUY: "tiles/:id/buy", // POST: 땅 구매
  UPGRADE: "tiles/:id/upgrade", // POST: 땅 업그레이드
  COLLECT: "collect", // POST: 방치 수익 수령
  RECORDS: "records", // GET: 안전 기록·수집
  RANKING: "ranking", // GET: 땅·주간 랭킹 (Redis)

  DEV_BASE: "v1/car/dev", // 시연 도구 (ROADLAND_DEV_TOOLS=true 일 때만)
  DEV_VEHICLES: "vehicles", // GET: 최근 등록 차량
  DEV_ADVANCE: "vehicles/:vehicleId/advance", // POST: 시계 앞당기기
  DEV_RESET: "vehicles/:vehicleId/reset", // POST: 처음 상태로
  DEV_SEED: "vehicles/:vehicleId/seed", // POST: 시연 기록 채우기
  DEV_REMOVE: "vehicles/:vehicleId", // DELETE: 차량 삭제
  DEV_ROUTE: "route", // GET: 시연 출근길 좌표
} as const;
