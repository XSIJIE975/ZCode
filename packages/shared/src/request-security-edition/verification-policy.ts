export type RequestVerificationConfig = Readonly<Record<string, unknown>>;
export type RequestVerificationProof = Record<never, never>;
export type RequestVerificationClientConfig = Record<never, never>;
// 定制缝合（feature/xcode）：在上游 reason 枚举上扩展 "captcha-retry"——
// 网关 3007（captcha verify failed）后占用唯一额外重试机会时的刷新原因，Start Plan 专属。
// 上游开源版的 verification 桩只认识 "model-request"；扩展该数组让
// RequestVerificationReason 联合类型覆盖定制侧 CaptchaRequestRetry 的 takeReason() 返回值，
// wire 校验（zcodeProviderRuntimeHeadersRequestReasonSchema）与各刷新签名共用同一来源。
export const requestVerificationReasons = ["model-request", "captcha-retry"] as const;
export type RequestVerificationReason = (typeof requestVerificationReasons)[number];
export const requestVerificationTimeoutMessage =
  "Provider runtime headers request timed out. Please send your message again.";
export const REQUEST_VERIFICATION_REQUIRED = "request_verification_unavailable";
export function readRequestVerificationConfig(
  _configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  return null;
}
export function requestVerificationClaimHeaders(
  _proof: RequestVerificationProof,
): Record<string, string> {
  return {};
}
export function withoutRequestVerificationHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return { ...headers };
}
export function allowRequestVerificationHeaders(
  _headers: Record<string, string>,
): Record<string, string> {
  return {};
}
export function requiresRequestVerification(_access: { mode: string } | undefined): boolean {
  return false;
}
export function isRequestVerificationMessage(_message: string): boolean {
  return false;
}
export function summarizeRequestVerificationHeaders(
  _headers: Record<string, string>,
): Record<string, unknown> {
  return {};
}
export function requestVerificationDiagnostics(
  _input: Record<string, unknown>,
): Record<string, unknown> {
  return {};
}

export const requestVerificationInteractionAvailable = false;
