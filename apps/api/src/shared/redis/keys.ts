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
