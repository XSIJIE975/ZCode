import type { ModelRequestRefreshReason } from "@zcode/contracts";
import { ProviderBusinessError } from "./model-execution.js";
import { inspectProviderFailure } from "./failure-classifier.js";

/**
 * 网关对 Start Plan 模型请求的反滥用校验失败码（captcha verify failed）。
 * 与发行版一致：严格字符串比较，不容忍数字形态以外的变体。
 */
const CAPTCHA_REJECTION_PROVIDER_CODE = "3007";

/** 网关 3007：验证码校验被拒（含 openai-compatible 空流合成错误）。 */
export function isCaptchaRejection(error: unknown): boolean {
  return inspectProviderFailure(error).providerErrorCode === CAPTCHA_REJECTION_PROVIDER_CODE;
}

/**
 * Start Plan 请求携带过验证码头却以空流收场（HTTP 200、无业务错误体）时，
 * 网关很可能静默拒绝了验签。按发行版语义合成 3007 业务错误，交给重试循环的
 * captcha claim 路径；非 Start Plan 或未携带验证码头时返回 undefined。
 */
export function createZcodePlanCaptchaEmptyStreamError(input: {
  headers: Record<string, string> | undefined;
  providerId: string;
  providerKind: "anthropic" | "openai" | "openai-compatible";
  startPlan: boolean;
}): ProviderBusinessError | undefined {
  if (!input.startPlan || input.providerKind !== "openai-compatible") {
    return undefined;
  }
  const captchaParam = Object.entries(input.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "x-aliyun-captcha-verify-param",
  )?.[1]?.trim();
  if (!captchaParam) {
    return undefined;
  }
  return new ProviderBusinessError({
    providerCode: CAPTCHA_REJECTION_PROVIDER_CODE,
    providerId: input.providerId,
    providerKind: input.providerKind,
    providerMessage: "Captcha verification failed or the verify token was rejected.",
    responseStatus: 200,
    statusCode: 403,
  });
}

interface CaptchaRetryRequest {
  abortSignal?: AbortSignal;
  refreshRuntimeHeadersBeforeAttempt?: unknown;
}

interface CaptchaRetryModel {
  accountAccess?: { mode?: string };
}

/**
 * Start Plan 验证码重试机会：单次模型请求至多一次额外物理尝试，不占普通 retry 预算。
 *
 * claim 的全部否定条件与发行版逐字对齐：已占用 / 已中止 / 请求没有 runtime-headers
 * 刷新回调 / 非 start-plan 账号 / 失败不是 3007。第二参为 veto（true = 拒绝领取），
 * 由调用方在「请求尚未构造完成就失败」等不值得验证码重试的场景传入。
 * pending 只在 claim 成功到下一次 takeReason() 之间为真，用于把那次刷新标记为
 * captcha-retry（Host/渲染端据此现跑一次新验证）。
 */
export class CaptchaRequestRetry {
  private readonly request: CaptchaRetryRequest;
  private readonly model: CaptchaRetryModel;
  private used = false;
  private pending = false;

  constructor(
    request: CaptchaRetryRequest,
    model: CaptchaRetryModel,
  ) {
    this.request = request;
    this.model = model;
  }

  /** 已占用的额外物理尝试数（0 或 1）；重试循环预算与状态上报按此放宽。 */
  get extraAttempts(): number {
    return Number(this.used);
  }

  /** 本次 attempt 的刷新原因；领取后的下一次刷新标记为 captcha-retry 并复位。 */
  takeReason(): ModelRequestRefreshReason {
    const reason = this.pending ? "captcha-retry" : "model-request";
    this.pending = false;
    return reason;
  }

  claim(error: unknown, veto = false): boolean {
    if (
      veto ||
      this.used ||
      this.request.abortSignal?.aborted ||
      !this.request.refreshRuntimeHeadersBeforeAttempt ||
      this.model.accountAccess?.mode !== "start-plan" ||
      !isCaptchaRejection(error)
    ) {
      return false;
    }
    this.used = true;
    this.pending = true;
    return true;
  }
}
