import type { SocialProviderSlug } from "@template/shared";
import { apiUrl } from "@/shared/libs/axios/base-url";

// 소셜 로그인은 XHR 이 아니라 브라우저 전체 리다이렉트(OAuth) 로 동작하므로,
// 버튼은 API 의 authorize 엔드포인트로 향하는 <a href> 링크다.
// 주소 조립은 base-url 의 apiUrl() 한 곳에서만 한다 (프리픽스·프로젝트명 중복 방지).
export const socialAuthUrl = (slug: SocialProviderSlug) =>
  apiUrl(`/v1/auth/social/${slug}`);

export interface SocialProviderMeta {
  slug: SocialProviderSlug;
  label: string;
}

// 노출할 provider 목록. 콘솔 앱 키가 준비된 것만 남기거나 순서를 조정하면 된다.
export const SOCIAL_PROVIDERS_UI: SocialProviderMeta[] = [
  { slug: "kakao", label: "카카오로 계속하기" },
  { slug: "naver", label: "네이버로 계속하기" },
  { slug: "discord", label: "Discord로 계속하기" },
];
