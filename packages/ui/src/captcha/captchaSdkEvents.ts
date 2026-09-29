// AliyunCaptcha SDK 回调事件处理：结果归一化与 fail 回调总处理（发行版 q4/J4/Y4/tnn）。
// 无模块状态：pending 操作由宿主（aliyunCaptcha.ts 的模块级单例）经参数注入。
import { logger } from "@/logger.js";
import { CaptchaInteractiveRequiredError } from "./aliyunCaptchaShared.js";

interface CaptchaCallbackPayload {
  verifyCode?: string;
  success?: boolean;
  verifyResult?: boolean;
  certifyId?: string;
}

export type { CaptchaCallbackPayload };

export interface SdkFailHooks {
  /** 当前 pending 验证（可能为 undefined）。 */
  getPending(): PendingVerificationRef | undefined;
  /** 取走 pending 并清空槽位（发行版「取出 n3 置 null」）。 */
  takePending(): PendingVerificationRef | undefined;
  /** 取走 pending 并置空后 reject（发行版 c3）。 */
  rejectCurrentPending(error: unknown): void;
  /** 整体复位控制器与挂载点（发行版 s3，F008 路径）。 */
  resetController(): void;
}

export interface PendingVerificationRef {
  allowInteractive: boolean;
  awaitingDeferredSdkSuccess?: boolean;
  resolve(param: string): void;
  reject(error: unknown): void;
}

export function readCallbackPayload(payload: unknown): CaptchaCallbackPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const result: CaptchaCallbackPayload = {};
  if (typeof record.verifyCode === "string") result.verifyCode = record.verifyCode;
  else if (typeof record.VerifyCode === "string") result.verifyCode = record.VerifyCode;
  if (typeof record.success === "boolean") result.success = record.success;
  if (typeof record.verifyResult === "boolean") result.verifyResult = record.verifyResult;
  if (typeof record.certifyId === "string") result.certifyId = record.certifyId;
  return result;
}

export function readVerifyParam(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["captchaVerifyParam", "CaptchaVerifyParam"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** fail 回调里携带 success+verifyResult=true 的终态通过（SDK 部分版本行为）。 */
export function isTerminalPass(payload: unknown): boolean {
  const normalized = readCallbackPayload(payload);
  if (!normalized) return false;
  return (
    (normalized.success === true && normalized.verifyResult === true) ||
    normalized.verifyCode === "T006"
  );
}

/** success=true + verifyResult=false + 无 verifyCode/F015：等待升级或无参通过。 */
export function isAwaitingUpgrade(payload: unknown): boolean {
  const normalized = readCallbackPayload(payload);
  return Boolean(
    normalized?.success === true &&
      normalized.verifyResult === false &&
      (!normalized.verifyCode || normalized.verifyCode === "F015"),
  );
}

export function isDuplicateSubmission(payload: unknown): boolean {
  return readCallbackPayload(payload)?.verifyCode === "F008";
}

/** fail 回调总处理（发行版 tnn）。 */
export function handleSdkFail(
  hooks: SdkFailHooks,
  payload: unknown,
  rejectInstance: (error: unknown) => void,
): void {
  const pending = hooks.getPending();
  if (!pending && (isTerminalPass(payload) || isAwaitingUpgrade(payload))) {
    logger.debug("[captcha] sdk.fail.stale_after_success", undefined);
    return;
  }
  logger.info("[captcha] aliyun sdk fail", {
    verifyCode: readCallbackPayload(payload)?.verifyCode ?? null,
  });

  // 1. 终态通过藏在 fail 里：带参数 → 直接通过；无参数 → 继续等 success。
  if (isTerminalPass(payload)) {
    const param = readVerifyParam(payload);
    if (param) {
      logger.info("[captcha] aliyun sdk terminal pass from fail", undefined);
      hooks.takePending();
      pending?.resolve(param);
      return;
    }
    if (pending) pending.awaitingDeferredSdkSuccess = true;
    return;
  }

  // 2. 等待升级/无参通过：无感模式抛交互必需；交互模式继续等（验证窗即将弹出）。
  if (isAwaitingUpgrade(payload)) {
    if (!pending) {
      rejectInstance(new CaptchaInteractiveRequiredError());
      return;
    }
    if (!pending.allowInteractive) {
      hooks.rejectCurrentPending(new CaptchaInteractiveRequiredError());
      return;
    }
    pending.awaitingDeferredSdkSuccess = true;
    return;
  }

  // 3. F008：验证数据已提交过，整体复位防继续复用。
  if (isDuplicateSubmission(payload)) {
    logger.warn("[captcha] aliyun sdk duplicate submission", undefined);
    hooks.resetController();
    if (pending && !pending.allowInteractive) {
      hooks.rejectCurrentPending(new CaptchaInteractiveRequiredError());
      return;
    }
    hooks.rejectCurrentPending(
      payload instanceof Error ? payload : new Error("Captcha verification data was already submitted."),
    );
    return;
  }

  // 4. 其余失败：无感模式升交互（抛 CAPTCHA_INTERACTIVE_REQUIRED）；交互模式直接失败。
  if (pending && !pending.allowInteractive) {
    hooks.rejectCurrentPending(new CaptchaInteractiveRequiredError());
    return;
  }
  const error = payload instanceof Error ? payload : new Error("Captcha failed.");
  rejectInstance(error);
  hooks.rejectCurrentPending(error);
}
