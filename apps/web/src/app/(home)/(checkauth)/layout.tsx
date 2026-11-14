import React from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { BaseResponse, MeResponse } from "@roadland/shared";
import { USER_STATUS } from "@roadland/shared";
import { apiUrl } from "@/shared/libs/axios/base-url";

interface LayoutProps {
  children: React.ReactNode;
}

/**
 * 로그인 필수 영역 SSR 가드.
 * SSR(서버) 에서는 브라우저 쿠키가 자동으로 붙지 않으므로 직접 Cookie 헤더로 넘긴다.
 * 주소는 반드시 `apiUrl()` 로 만든다 (서버에서는 API_BASE_URL, 프리픽스 자동).
 */
const getMe = async (): Promise<Response | null> => {
  const cookieStore = await cookies();
  const cookieString = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  try {
    return await fetch(apiUrl("/v1/auth/mypage"), {
      method: "GET",
      headers: { Cookie: cookieString },
      cache: "no-store",
    });
  } catch {
    return null;
  }
};

const layout = async ({ children }: LayoutProps) => {
  const response = await getMe();

  if (!response || !response.ok) {
    redirect("/auth/login");
  }

  const body = (await response.json()) as BaseResponse<MeResponse>;
  const user = body.data?.user;
  if (!user) {
    redirect("/auth/login");
  }

  if (user.status === USER_STATUS.ACTIVE) {
    return <main className='overflow-y-auto'>{children}</main>;
  }

  if (user.status === USER_STATUS.PENDING) {
    redirect("/auth/pending");
  }

  redirect("/auth/not-auth");
};

export default layout;
