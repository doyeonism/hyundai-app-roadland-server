import React from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { BaseResponse, MeResponse } from "@loadland/shared";
import { USER_STATUS } from "@loadland/shared";
import { apiUrl } from "@/shared/libs/axios/base-url";
import { Sidebar } from "@/widgets/sidebar";

interface LayoutProps {
  children: React.ReactNode;
}

/**
 * 관리자 영역 SSR 가드.
 *
 * `/v1/auth/mypage` 가 아니라 **`/v1/admin/me`** 를 부른다. 이 엔드포인트는
 * `JwtAccessGuard` → `RolesGuard(ADMIN)` 뒤에 있어서, 200 이 돌아왔다는 것 자체가
 * "로그인됨 + ADMIN" 의 증명이다. 쿠키가 `.도메인` 으로 서브도메인 간 공유되므로
 * web 에 로그인한 일반 USER 도 admin 서브도메인에 쿠키를 들고 들어온다 — 여기서
 * 역할을 보지 않으면 관리자 화면이 그대로 렌더링된다(API 호출만 403).
 *
 * SSR(서버) 에서는 브라우저 쿠키가 자동으로 붙지 않으므로 직접 Cookie 헤더로 넘긴다.
 */
const getAdminMe = async (): Promise<Response | null> => {
  const cookieStore = await cookies();
  const cookieString = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  try {
    return await fetch(apiUrl("/v1/admin/me"), {
      method: "GET",
      headers: { Cookie: cookieString },
      cache: "no-store",
    });
  } catch {
    // API 가 죽어 있거나 주소가 틀린 경우 — 500 페이지 대신 로그인으로 보낸다.
    return null;
  }
};

const layout = async ({ children }: LayoutProps) => {
  const response = await getAdminMe();

  // 401(미로그인·정지) / 403(ADMIN 아님) / 네트워크 오류 모두 로그인 페이지로.
  if (!response || !response.ok) {
    redirect("/auth/login");
  }

  const body = (await response.json()) as BaseResponse<MeResponse>;
  const user = body.data?.user;
  if (!user) {
    redirect("/auth/login");
  }

  if (user.status !== USER_STATUS.ACTIVE) {
    redirect("/auth/login");
  }

  return (
    <div className='flex h-screen w-screen overflow-hidden bg-slate-950'>
      {/* 클라이언트로 넘기는 건 사이드바가 쓰는 두 필드만 — 전체 user 행을 RSC 페이로드에 싣지 않는다 */}
      <Sidebar user={{ nickname: user.nickname, email: user.email }} />
      <main className='flex-1 overflow-y-auto bg-slate-950 p-8 text-slate-100'>
        {children}
      </main>
    </div>
  );
};

export default layout;
