import type { Terms, UserTermsAgreement } from "@roadland/database";

export interface TermsAgreementInput {
  termsId: string;
  isAgreed: boolean;
}

export interface SubmitTermsAgreementRequest {
  agreements: TermsAgreementInput[];
}

export interface SubmitTermsAgreementResponse {
  agreements: UserTermsAgreement[];
}

export interface TermsDetail extends Terms {}
