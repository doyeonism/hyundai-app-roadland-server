/**
 * Redis 키 네이밍의 단일 출처.
 * auth / admin / passport 가 같은 키를 다루므로 문자열을 각자 조립하지 않는다.
 */

/** 사용자별 refresh 토큰 (회전 시 덮어씀, 로그아웃·정지 시 삭제) */
export const refreshKey = (userId: string) => `refresh:${userId}`;

/**
 * 계정 정지 플래그. 관리자가 SUSPENDED 로 바꾸면 세팅되고(TTL = 액세스 토큰 만료),
 * 액세스 토큰 검증(JwtAccessStrategy)이 매 요청 확인해 이미 발급된 토큰도 즉시 거부한다.
 */
export const suspendedKey = (userId: string) => `suspended:${userId}`;

// --- 로드랜드 (apps/api/src/roadland) ---------------------------------------

/** 기기 토큰 해시 → 차량 ID 캐시. 매 요청 DB 조회를 피한다. */
export const vehicleTokenKey = (tokenHash: string) => `rl:token:${tokenHash}`;

/** 차량별 쓰기 잠금. 정산·구매·업그레이드·수령이 같은 잔액을 동시에 건드리지 않게 한다. */
export const vehicleLockKey = (vehicleId: string) => `rl:lock:${vehicleId}`;

/** 땅 점수 랭킹(가진 땅 레벨 합). sorted set. */
export const landRankKey = () => "rl:rank:land";

/** 주간 주행 크레딧 랭킹. week 는 그 주 월요일(서울, YYYY-MM-DD). sorted set. */
export const weeklyRankKey = (week: string) => `rl:rank:weekly:${week}`;

/** 시연용 시계 오프셋(ms). ROADLAND_DEV_TOOLS 가 켜졌을 때만 쓴다. */
export const vehicleClockKey = (vehicleId: string) => `rl:clock:${vehicleId}`;
