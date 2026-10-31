// Stable machine-readable error codes (spec 8.5, 13.3) plus a few transport codes.
// Messages are short, neutral and safe to print: never keys, headers, upstream bodies or user input.
export const ERROR_CODES = [
  "policy_violation",
  "owner_policy",
  "key_in_body",
  "missing_parameter",
  "unsupported_skill",
  "rate_limited",
  "auth_required",
  "llm_key_invalid",
  "llm_quota",
  "upstream_unavailable",
  "invalid_params",
  "payload_too_large",
  "unsupported_media_type",
  "method_not_allowed",
  "not_implemented",
  "not_found",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly retryAfter: number | undefined;
  constructor(code: ErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  policy_violation: 403,
  owner_policy: 403,
  key_in_body: 400,
  missing_parameter: 400,
  unsupported_skill: 400,
  rate_limited: 429,
  auth_required: 401,
  llm_key_invalid: 401,
  llm_quota: 402,
  upstream_unavailable: 502,
  invalid_params: 400,
  payload_too_large: 413,
  unsupported_media_type: 415,
  method_not_allowed: 405,
  not_implemented: 501,
  not_found: 404,
  internal_error: 500,
};

export const errorBody = (code: ErrorCode, message: string) => ({ error: { code, message } });
