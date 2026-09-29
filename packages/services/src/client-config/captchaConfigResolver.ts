import type { ClientCaptchaConfig } from "@zcode/shared";
import type { IClientConfigService } from "./clientConfig.js";

const CAPTCHA_CONFIG_TTL_MS = 60_000;

/**
 * Start Plan 验证码门禁配置解析器（发行版 f3 语义）：
 * 成功结果缓存 60s；读取失败返回 null 且不缓存（下次重试）；并发请求共享同一 in-flight Promise。
 * 配置属于服务端策略，1h 的快照级缓存对 skip 开关回摆太钝，这里独立做短 TTL。
 */
export function createCaptchaConfigResolver(dependencies: {
  clientConfigService: IClientConfigService;
}): () => Promise<ClientCaptchaConfig | null> {
  let cache: { value: ClientCaptchaConfig | null; expiresAt: number } | undefined;
  let pending: Promise<ClientCaptchaConfig | null> | undefined;

  return () => {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return Promise.resolve(cache.value);
    }
    if (pending) return pending;
    pending = (async () => {
      try {
        const snapshot = await dependencies.clientConfigService.getSnapshot({
          forceRefresh: true,
        });
        const value = snapshot.captcha;
        cache = { value, expiresAt: Date.now() + CAPTCHA_CONFIG_TTL_MS };
        return value;
      } catch {
        // 读取失败不写缓存：下次请求立刻重试，避免故障期把「无配置」钉死 60s。
        return null;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
