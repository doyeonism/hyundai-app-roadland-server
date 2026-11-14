// 관리자 도메인 API 계약
import type {
  UserSubscription,
  SubscriptionPlan,
  UserTermsAgreement,
  Terms,
} from "@loadland/database";
import type { Role } from "../../src/roles";
import type { SafeUser } from "../models/auth/user";

export interface UpdateUserRoleRequest {
  role: Role;
}

export interface UpdateUserRoleResponse {
  user: SafeUser;
}

// 사용자 정보 수정 (닉네임·계정 상태) — ADMIN 전용. 필드는 선택적(부분 수정).
export interface UpdateUserRequest {
  nickname?: string;
  status?: string; // "ACTIVE" | "PENDING" | "SUSPENDED"
}

export interface UpdateUserResponse {
  user: SafeUser;
}

export interface UserSubscriptionDetail extends UserSubscription {
  user: {
    email: string;
    nickname: string;
  };
  plan: SubscriptionPlan;
}

export interface UserWithAgreements extends SafeUser {
  termsAgreements?: (UserTermsAgreement & {
    terms: Terms;
  })[];
}

export interface CreateTermsRequest {
  title: string;
  type: string;
  version: string;
  isRequired: boolean;
  isActive: boolean;
  fileId?: string;
}

export interface CreateTermsResponse {
  terms: Terms;
}

export interface UpdateTermsActiveRequest {
  isActive: boolean;
}

export interface UpdateTermsActiveResponse {
  terms: Terms;
}