// AliyunCaptcha 共享原语：跨 captcha 模块引用的错误类型与纯解析函数。
// 拆出动机：aliyunCaptcha.ts（状态机）与 captchaSdkEvents.ts（回调归一化）互相引用时
// 需要一个无依赖的公共底层，避免循环 import。

/** SDK 无感通过被拒、需要交互时的类型化错误；上层据此决定是否弹窗。 */
export class CaptchaInteractiveRequiredError extends Error {
  readonly code = "CAPTCHA_INTERACTIVE_REQUIRED";
  constructor(message = "Captcha requires interactive verification.") {
    super(message);
    this.name = "CaptchaInteractiveRequiredError";
  }
}

/** 解析 captchaVerifyParam 内嵌的 certifyId（发行版 Utn）。 */
export function extractCertifyId(captchaVerifyParam: string): string | undefined {
  const trimmed = captchaVerifyParam.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const certifyId = (parsed as Record<string, unknown>).certifyId;
      if (typeof certifyId === "string") return certifyId;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
