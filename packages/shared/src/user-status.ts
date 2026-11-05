// 사용자 계정 상태 (api·web·admin 공통) — DB User.status 와 일치
// ACTIVE    : 정상
// PENDING   : 승인 대기 (로그인은 되지만 checkauth 레이아웃이 /auth/pending 으로 보냄)
// SUSPENDED : 정지 — API 가 login/refresh/소셜 로그인/액세스 토큰 검증에서 모두 거부
export const USER_STATUS = {
  ACTIVE: "ACTIVE",
  PENDING: "PENDING",
  SUSPENDED: "SUSPENDED",
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];
