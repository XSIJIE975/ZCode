// Start Plan 验证码重试单元测试：claim 条件矩阵、takeReason/extraAttempts 时序、
// 空流合成 3007、ProviderBusinessError 识别。对应发行版 CaptchaRequestRetry 移植，
// 防止后续改动破坏重试语义对齐（协议细节见 docs/specs/start-plan-captcha.md）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CaptchaRequestRetry,
  createZcodePlanCaptchaEmptyStreamError,
  isCaptchaRejection,
} from "../src/model/captcha-request-retry.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";

function captchaError(): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: "3007",
    providerId: "builtin:zcode-plan",
    providerKind: "anthropic",
    providerMessage: "captcha verify failed",
    responseStatus: 400,
    statusCode: 400,
  });
}

function quotaError(): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: "1005",
    providerId: "builtin:zcode-plan",
    providerKind: "anthropic",
    providerMessage: "insufficient quota",
  });
}

function makeRetry(overrides?: {
  aborted?: boolean;
  hasRefresh?: boolean;
  mode?: string;
}): CaptchaRequestRetry {
  const controller = new AbortController();
  if (overrides?.aborted) controller.abort();
  return new CaptchaRequestRetry(
    {
      abortSignal: controller.signal,
      ...(overrides?.hasRefresh === false
        ? {}
        : { refreshRuntimeHeadersBeforeAttempt: async () => ({ headersApplied: true }) }),
    },
    {
      accountAccess: { mode: overrides?.mode ?? "start-plan" },
    },
  );
}

test("isCaptchaRejection 只认 providerErrorCode=3007 的业务错误", () => {
  assert.equal(isCaptchaRejection(captchaError()), true);
  assert.equal(isCaptchaRejection(quotaError()), false);
  assert.equal(isCaptchaRejection(new Error("captcha verify failed")), false);
  assert.equal(isCaptchaRejection(undefined), false);
});

test("claim：start-plan + 3007 + 有刷新回调时领取成功且仅一次", () => {
  const retry = makeRetry();
  assert.equal(retry.extraAttempts, 0);
  assert.equal(retry.takeReason(), "model-request");
  assert.equal(retry.claim(captchaError()), true);
  assert.equal(retry.extraAttempts, 1);
  // 单请求内只能领取一次
  assert.equal(retry.claim(captchaError()), false);
});

test("takeReason：领取后的下一次刷新标记为 captcha-retry 并随即复位", () => {
  const retry = makeRetry();
  assert.equal(retry.claim(captchaError()), true);
  assert.equal(retry.takeReason(), "captcha-retry");
  assert.equal(retry.takeReason(), "model-request");
});

test("claim 矩阵：非 start-plan / 无刷新回调 / 已中止 / 非 3007 全部拒绝", () => {
  assert.equal(makeRetry({ mode: "individual-coding-plan" }).claim(captchaError()), false);
  assert.equal(makeRetry({ mode: "off-peak" }).claim(captchaError()), false);
  assert.equal(makeRetry({ hasRefresh: false }).claim(captchaError()), false);
  assert.equal(makeRetry({ aborted: true }).claim(captchaError()), false);
  assert.equal(makeRetry().claim(quotaError()), false);
  assert.equal(makeRetry().claim(new Error("network down")), false);
});

test("claim veto：请求构造完成前的失败不领取，也不消耗唯一机会", () => {
  const retry = makeRetry();
  assert.equal(retry.claim(captchaError(), true), false);
  assert.equal(retry.extraAttempts, 0);
  // veto 之后同一请求内仍可正常领取
  assert.equal(retry.claim(captchaError()), true);
});

test("空流合成：start-plan + openai-compatible + 携带验证码头 → 3007 业务错误", () => {
  const error = createZcodePlanCaptchaEmptyStreamError({
    headers: { "X-Aliyun-Captcha-Verify-Param": "  param-value  " },
    providerId: "builtin:zcode-plan",
    providerKind: "openai-compatible",
    startPlan: true,
  });
  assert.ok(error);
  assert.equal(String(error.providerCode), "3007");
  assert.equal(error.statusCode, 403);
  assert.equal(isCaptchaRejection(error), true);
});

test("空流合成：未携带验证码头 / 非 start-plan / 非 openai-compatible 均不合成", () => {
  assert.equal(
    createZcodePlanCaptchaEmptyStreamError({
      headers: {},
      providerId: "p",
      providerKind: "openai-compatible",
      startPlan: true,
    }),
    undefined,
  );
  assert.equal(
    createZcodePlanCaptchaEmptyStreamError({
      headers: { "x-aliyun-captcha-verify-param": "param" },
      providerId: "p",
      providerKind: "openai-compatible",
      startPlan: false,
    }),
    undefined,
  );
  assert.equal(
    createZcodePlanCaptchaEmptyStreamError({
      headers: { "x-aliyun-captcha-verify-param": "param" },
      providerId: "p",
      providerKind: "anthropic",
      startPlan: true,
    }),
    undefined,
  );
  assert.equal(
    createZcodePlanCaptchaEmptyStreamError({
      headers: undefined,
      providerId: "p",
      providerKind: "openai-compatible",
      startPlan: true,
    }),
    undefined,
  );
});
