// AliyunCaptcha 验证执行（发行版 snn）：无感优先、被拒升交互、超时/abort 全对齐。
// 状态（控制器/pending/进行中标志）在 aliyunCaptcha.ts 的 captchaRuntime 单例，两文件共享。
import { logger } from "@/logger.js";
import type { AliyunCaptchaConfig, PendingVerification } from "./aliyunCaptcha.js";
import {
  captchaRuntime,
  ensureController,
  isCurrentController,
  rejectCurrentPending,
  resetController,
  settleAfterScriptLoad,
  waitForInstance,
} from "./aliyunCaptcha.js";

const VERIFICATION_TIMEOUT_MS = 120_000;

export interface RunCaptchaVerificationInput {
  config: AliyunCaptchaConfig;
  requestId: string;
  providerId: string;
  signal?: AbortSignal;
  onInteractiveChallenge?: () => void;
}

/**
 * 跑一次人机验证：优先无感通过，被拒时升交互（onInteractiveChallenge 触发一次）。
 * 成功 resolve captchaVerifyParam；abort 以 signal.reason 拒绝。
 */
export async function runCaptchaVerification(
  input: RunCaptchaVerificationInput,
): Promise<string> {
  if (typeof document === "undefined") {
    throw new Error("Captcha requires browser environment.");
  }
  if (captchaRuntime.pendingVerification || captchaRuntime.verificationInFlight) {
    throw new Error("Captcha verification is already in progress.");
  }
  captchaRuntime.verificationInFlight = true;
  const { signal } = input;
  let interactiveDisplayed = false;
  try {
    const target = await ensureController(input.config, signal);
    logger.debug("[captcha] controller.bound", { controllerKey: target.configKey });
    await settleAfterScriptLoad(signal);
    signal?.throwIfAborted();

    // attemptToken 防串扰：并发验证在入口被拒，但 SDK 迟到回调仍可能落进来；
    // 所有回调/超时只作用于仍挂在 pendingVerification 上的本次对象。
    const attemptToken: PendingVerification = {
      resolve: () => {},
      reject: () => {},
      allowInteractive: true,
    };
    const result = new Promise<string>((resolve, reject) => {
      attemptToken.resolve = resolve;
      attemptToken.reject = reject;
      captchaRuntime.pendingVerification = attemptToken;
    });

    const attemptKind = "auto";
    logger.info("[captcha] aliyun execute start", {
      allowInteractive: true,
      attemptKind,
      timeoutMs: VERIFICATION_TIMEOUT_MS,
    });

    // 触发：无感 API 在场直接跑；否则回退按钮点击（会弹验证窗）。
    void (async () => {
      const readPending = (): PendingVerification | undefined => captchaRuntime.pendingVerification;
      try {
        const instance = await waitForInstance(target, signal);
        if (!isCurrentController(target)) return;
        if (readPending() !== attemptToken) return;
        if (typeof instance.startTracelessVerification === "function") {
          logger.info("[captcha] aliyun start traceless verification", { attemptKind });
          instance.startTracelessVerification();
          return;
        }
        input.onInteractiveChallenge?.();
        interactiveDisplayed = true;
        logger.info("[captcha] aliyun fallback button click", { attemptKind });
        target.buttonElement.click();
      } catch (error) {
        if (!isCurrentController(target)) return;
        const pending = readPending();
        if (pending !== attemptToken) return;
        // fail 回调已宣告等待 deferred success 时不打断（SDK 随后仍会 success）。
        if (pending.awaitingDeferredSdkSuccess) return;
        rejectCurrentPending(
          error instanceof Error ? error : new Error("Captcha instance was not ready."),
        );
      }
    })();

    // 总时限：awaitingDeferredSdkSuccess（fail 已宣告等 success）时跳过，与发行版一致。
    const timeoutHandle = setTimeout(() => {
      if (captchaRuntime.pendingVerification !== attemptToken) return;
      if (captchaRuntime.pendingVerification.awaitingDeferredSdkSuccess) {
        logger.debug("[captcha] traceless.timeout.skipped", {
          reason: "awaiting_deferred_sdk_success",
          timeoutMs: VERIFICATION_TIMEOUT_MS,
        });
        return;
      }
      logger.debug(
        interactiveDisplayed ? "[captcha] interactive.timeout" : "[captcha] traceless.timeout",
        { timeoutMs: VERIFICATION_TIMEOUT_MS },
      );
      rejectCurrentPending(
        new Error(`Captcha verification timed out after ${VERIFICATION_TIMEOUT_MS}ms.`),
      );
    }, VERIFICATION_TIMEOUT_MS);
    timeoutHandle.unref?.();

    const onAbort = (): void => {
      if (captchaRuntime.pendingVerification !== attemptToken) return;
      logger.debug("[captcha] attempt.cancel", undefined);
      resetController(captchaRuntime.controller);
      rejectCurrentPending(signal?.reason ?? new Error("Captcha request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await result;
    } finally {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    captchaRuntime.verificationInFlight = false;
  }
}
