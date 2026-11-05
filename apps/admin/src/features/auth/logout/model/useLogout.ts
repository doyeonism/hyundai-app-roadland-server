"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { Post } from "@/shared/libs/axios/request";

/**
 * 로그아웃 뮤테이션 (feature model).
 *
 * 서버의 `/v1/auth/logout` 이 Redis 의 refresh 토큰을 폐기하고 `Set-Cookie` 로
 * 두 쿠키(`${PROJECT_NAME}_access_token` / `_refresh_token`)를 지운다. 쿠키는
 * httpOnly + Domain 이 붙어 있어 브라우저에서 직접 지울 수 없고, 서버 액션의
 * `cookies().delete()` 도 이름·Domain 이 맞지 않으면 아무 효과가 없다 — 그래서
 * 반드시 API 를 호출해야 하고, 그러면 브라우저가 응답의 Set-Cookie 를 그대로 적용한다.
 *
 * 액세스 토큰이 만료돼 401 이 나면 axios 인터셉터가 먼저 재발급 후 재시도한다.
 * API 호출 자체가 실패해도(네트워크 등) 캐시를 비우고 로그인 페이지로 보낸다 —
 * 남은 쿠키는 다음 요청에서 다시 401/재발급 흐름을 타므로 화면이 멈추지 않는다.
 */
export const useLogout = () => {
  const router = useRouter();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: () => Post("/v1/auth/logout", {}),
    onSettled: () => {
      qc.clear();
      router.replace("/auth/login");
      router.refresh();
    },
  });
};
