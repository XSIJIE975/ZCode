// Start Plan 人机验证宿主：渲染隐藏的 AliyunCaptcha 挂载 DOM，并接线验证码请求处理。
// 挂在 Root Provider 树内（desktop 本地窗口）；web/远端窗口平台无此能力时不订阅。
import type { IPlatformService } from "@zcode/shared";
import { CaptchaHostElements } from "@/captcha/CaptchaHostElements.js";
import { useStartPlanCaptchaVerification } from "@/captcha/useStartPlanCaptchaVerification.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function StartPlanCaptchaHost() {
  const platform = useOptionalPlatform();
  const { clientConfigService } = useServices();
  const { locale } = useZCodeIntl();
  useStartPlanCaptchaVerification({
    platform: platform as IPlatformService | undefined,
    clientConfigService,
    locale,
  });
  return <CaptchaHostElements />;
}
