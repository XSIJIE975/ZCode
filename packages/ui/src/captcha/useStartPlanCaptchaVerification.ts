// Start Plan 人机验证的渲染端接线：订阅平台验证码请求 → 跑 AliyunCaptcha → 回执。
// 诊断日志与 certifyId 防重复提交告警对齐发行版（[captcha] 前缀）。
import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { runCaptchaVerification, type AliyunCaptchaConfig } from "@/captcha/aliyunCaptcha.js";
import { extractCertifyId } from "@/captcha/aliyunCaptchaShared.js";
import { logger } from "@/logger.js";

interface CaptchaHookDeps {
  platform: IPlatformService | undefined;
  clientConfigService:
    | {
        getSnapshot(options?: { forceRefresh?: boolean }): Promise<{
          captcha: {
            enabled?: boolean;
            region?: string;
            prefix?: string;
            sceneId?: string;
            skipModelRequest?: boolean;
          } | null;
        }>;
      }
    | undefined;
  locale: string;
}

/** 从应用语言偏好推导 SDK 语言（发行版 Ann：zh→cn，其余→en）。 */
function resolveSdkLanguage(locale: string): "cn" | "en" {
  return locale.toLowerCase().startsWith("zh") ? "cn" : "en";
}

const lastCertifyIdByProvider = new Map<string, string>();

/**
 * 挂载一次即可：监听平台的验证码请求（desktop Main 转发），逐个执行并回执。
 * 同一时刻只处理一个请求（AliyunCaptcha 全局单例约束）；请求期间到达的后续请求
 * 按「已有验证进行中」回执失败，由 Host 侧 180s 端口超时兜底。
 */
export function useStartPlanCaptchaVerification(dependencies: CaptchaHookDeps): void {
  const depsRef = useRef(dependencies);
  depsRef.current = dependencies;

  useEffect(() => {
    const platform = dependencies.platform;
    if (!platform?.onCaptchaVerifyRequested || !platform.submitCaptchaVerifyResult) {
      return;
    }
    let inFlight = false;
    const queue: Array<{ requestId: string; reason: "model-request" | "captcha-retry" }> = [];

    const drain = (): void => {
      if (inFlight || queue.length === 0) return;
      const request = queue.shift()!;
      inFlight = true;
      void (async () => {
        try {
          const service = depsRef.current.clientConfigService;
          if (!service) {
            logger.warn("[captcha] 无配置服务依赖，无法执行人机验证", { requestId: request.requestId });
            platform.submitCaptchaVerifyResult!({
              requestId: request.requestId,
              ok: false,
              errorKind: "service_missing",
            });
            return;
          }
          const snapshot = await service.getSnapshot({ forceRefresh: true });
          const captcha = snapshot.captcha;
          if (!captcha || captcha.enabled === false || captcha.skipModelRequest === true
            || !captcha.region || !captcha.prefix || !captcha.sceneId) {
            // Host 已做 skip 判定；到这里仍不完整按配置缺失失败，不静默放行。
            logger.warn("[captcha] 验证码配置缺失或不完整", { requestId: request.requestId });
            platform.submitCaptchaVerifyResult!({
              requestId: request.requestId,
              ok: false,
              errorKind: "config_missing",
            });
            return;
          }
          const config: AliyunCaptchaConfig = {
            region: captcha.region,
            prefix: captcha.prefix,
            sceneId: captcha.sceneId,
            language: resolveSdkLanguage(depsRef.current.locale),
          };
          logger.info("[captcha-diagnostics]", {
            event: "request.received",
            requestId: request.requestId,
            source: request.reason === "captcha-retry" ? "captcha_retry" : "send_preflight",
          });
          const param = await runCaptchaVerification({
            config,
            requestId: request.requestId,
            providerId: "",
            // 调试开关：localStorage 设 zcode-captcha-force-interactive=1 时跳过无感直接弹窗。
            preferInteractive:
              typeof localStorage !== "undefined" &&
              localStorage.getItem("zcode-captcha-force-interactive") === "1",
            onInteractiveChallenge: () => {
              logger.info("[captcha] interactive challenge displayed", {
                requestId: request.requestId,
              });
            },
          });
          // F008 防重复提交告警：certifyId 与上一轮完全相同 ⇒ SDK/网关可能拒绝。
          const certifyId = extractCertifyId(param);
          if (certifyId) {
            const previous = lastCertifyIdByProvider.get("");
            if (previous === certifyId) {
              logger.warn("[captcha] certifyId 与上一轮相同，请求可能触发 F008 重复提交", {
                requestId: request.requestId,
              });
            }
            lastCertifyIdByProvider.set("", certifyId);
            logger.debug("[captcha] prepared certifyId for send", {
              requestId: request.requestId,
              reusedFromPrevious: previous === certifyId,
            });
          }
          platform.submitCaptchaVerifyResult!({
            requestId: request.requestId,
            ok: true,
            captchaVerifyParam: param,
            captchaRegion: captcha.region,
          });
          logger.info("[captcha-diagnostics]", {
            event: "request.respond",
            requestId: request.requestId,
            headersApplied: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("[captcha] provider runtime headers refresh failed", {
            requestId: request.requestId,
            error: message,
          });
          platform.submitCaptchaVerifyResult!({
            requestId: request.requestId,
            ok: false,
            errorMessage: message,
          });
        } finally {
          inFlight = false;
          drain();
        }
      })();
    };

    const dispose = platform.onCaptchaVerifyRequested((request) => {
      queue.push(request);
      drain();
    });
    return dispose;
  }, [dependencies.platform]);
}
