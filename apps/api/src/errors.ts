import type { ApiErrorBody, AskErrorCode } from "@nova-agent/protocol";

export const errorBody = (code: AskErrorCode, message: string, extra: { retryable?: boolean; retryAfterSeconds?: number } = {}): ApiErrorBody => ({
  error: { code, message, ...extra },
});
