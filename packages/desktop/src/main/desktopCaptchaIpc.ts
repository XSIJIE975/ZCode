import { BrowserWindow, ipcMain, type BrowserWindow as BrowserWindowType } from "electron";
import { PlatformChannels } from "@zcode/shared";

/**
 * Start Plan 人机验证 Main↔Renderer 桥。
 *
 * Host 进程经 desktopHostProcess 依赖回调 requestCaptchaVerification 进入这里；
 * Main 把请求投给一个可见窗口的渲染端（AliyunCaptcha 需要 DOM），渲染端跑完后经
 * CaptchaVerifyResult 回执到 Main，Main 把结果原样 postMessage 回 Host 进程
 * （HostMessageTypes.CaptchaVerifyResult，Host 内 pending bridge 裁决）。
 * 验证参数只在内存传递，不落日志。
 */

export interface DesktopCaptchaLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface DesktopCaptchaVerifyRequest {
  requestId: string;
  sessionId: string;
  providerId: string;
  reason: "model-request" | "captcha-retry";
}

export interface DesktopCaptchaVerifyResult {
  requestId: string;
  ok: boolean;
  captchaVerifyParam?: string;
  captchaRegion?: string;
  errorMessage?: string;
  errorKind?: string;
}

interface PendingRendererVerification {
  timeout: ReturnType<typeof setTimeout>;
  settle: (message: DesktopCaptchaVerifyResult) => void;
}

const pendingRendererVerifications = new Map<string, PendingRendererVerification>();
/** Host 侧总时限 150s；Main 侧留 10s 余量避免 Host 先超时导致回执变成迟到。 */
const RENDERER_CAPTCHA_TIMEOUT_MS = 140_000;

/**
 * 注册渲染端回执通道并返回 Host 依赖回调。
 * postToHost 由调用方（main/index.ts）提供：把 CaptchaVerifyResult 投回对应 host 进程。
 */
export function registerCaptchaVerifyIpc(
  logger: DesktopCaptchaLogger,
  postToHost: (result: DesktopCaptchaVerifyResult) => void,
): {
  requestCaptchaVerification: (
    input: DesktopCaptchaVerifyRequest,
  ) => Promise<{ captchaVerifyParam: string; captchaRegion?: string }>;
} {
  ipcMain.on(PlatformChannels.CaptchaVerifyResult, (_event, value: unknown) => {
    const message = readVerifyResult(value);
    if (!message) return;
    const pending = pendingRendererVerifications.get(message.requestId);
    // 无论 Main 是否还持有 pending，结果都要回 Host（迟到/未知 requestId 在 Host 侧幂等丢弃）。
    postToHost(message);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRendererVerifications.delete(message.requestId);
      // 依赖回调的 Promise 由回执 settle；desktopHostProcess 的 .then/.catch 只做日志。
      pending.settle(message);
    }
    logger.info(undefined, "Start Plan 人机验证回执已处理", {
      requestId: message.requestId,
      ok: message.ok,
      errorKind: message.errorKind ?? null,
    });
  });

  return {
    requestCaptchaVerification(input) {
      const win = pickCaptchaWindow();
      if (!win) {
        logger.warn(undefined, "Start Plan 人机验证无可用窗口，按失败返回", {
          providerId: input.providerId,
          requestId: input.requestId,
        });
        postToHost({
          requestId: input.requestId,
          ok: false,
          errorKind: "no_window_available",
        });
        return Promise.reject(new Error("no_window_available"));
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (pendingRendererVerifications.delete(input.requestId)) {
            logger.warn(undefined, "Start Plan 人机验证渲染端回执超时", {
              providerId: input.providerId,
              requestId: input.requestId,
            });
            reject(new Error("renderer_captcha_timeout"));
          }
        }, RENDERER_CAPTCHA_TIMEOUT_MS);
        timeout.unref?.();
        pendingRendererVerifications.set(input.requestId, {
          timeout,
          settle: (message) => {
            if (message.ok && message.captchaVerifyParam) {
              resolve({
                captchaVerifyParam: message.captchaVerifyParam,
                ...(message.captchaRegion ? { captchaRegion: message.captchaRegion } : {}),
              });
              return;
            }
            reject(new Error(message.errorKind ?? message.errorMessage ?? "captcha_failed"));
          },
        });
        win.webContents.send(PlatformChannels.CaptchaVerifyRequested, {
          requestId: input.requestId,
          reason: input.reason,
        });
        logger.info(undefined, "Start Plan 人机验证请求已投递渲染端", {
          providerId: input.providerId,
          reason: input.reason,
          requestId: input.requestId,
        });
      });
    },
  };
}

function readVerifyResult(value: unknown): DesktopCaptchaVerifyResult | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return undefined;
  return {
    requestId: record.requestId,
    ok: record.ok === true,
    ...(typeof record.captchaVerifyParam === "string"
      ? { captchaVerifyParam: record.captchaVerifyParam }
      : {}),
    ...(typeof record.captchaRegion === "string" ? { captchaRegion: record.captchaRegion } : {}),
    ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
    ...(typeof record.errorKind === "string" ? { errorKind: record.errorKind } : {}),
  };
}

function pickCaptchaWindow(): BrowserWindowType | null {
  const candidates = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && win.isVisible() && !win.webContents.isLoading(),
  );
  return BrowserWindow.getFocusedWindow() ?? candidates[0] ?? null;
}
