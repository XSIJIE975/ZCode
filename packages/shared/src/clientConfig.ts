import { z } from "zod";
import { parsePluginStoreOrder, type PluginStoreOrder } from "./pluginStoreOrder.js";

/**
 * 服务端验证码门禁配置（Start Plan 模型请求反滥用）。
 * `skipModelRequest` 由服务端 snake_case 字段规范化而来；为 true 时 Host 跳过
 * 验证码，模型请求不携带验证码头发送。
 */
export interface ClientCaptchaConfig {
  enabled?: boolean;
  region?: string;
  prefix?: string;
  sceneId?: string;
  skipModelRequest?: boolean;
}

/** 只允许显式接入的公开字段进入服务快照，不透传账户或 Provider 配置。 */
export interface ClientConfigSnapshot {
  pluginStoreOrder: PluginStoreOrder | null;
  captcha: ClientCaptchaConfig | null;
}

export const clientConfigReadOptionsSchema = z.object({
  forceRefresh: z.boolean().optional(),
});
export type ClientConfigReadOptions = z.infer<typeof clientConfigReadOptionsSchema>;

const envelopeSchema = z.object({
  code: z.literal(0),
  data: z
    .object({
      configs: z
        .object({
          pluginStoreOrder: z.unknown().optional(),
          captcha: z.unknown().optional(),
        })
        .nullish(),
    })
    .nullish(),
});

function parseCaptchaConfig(value: unknown): ClientCaptchaConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const captcha: ClientCaptchaConfig = {};
  if (typeof record.enabled === "boolean") captcha.enabled = record.enabled;
  if (typeof record.region === "string") captcha.region = record.region;
  if (typeof record.prefix === "string") captcha.prefix = record.prefix;
  if (typeof record.sceneId === "string") captcha.sceneId = record.sceneId;
  // 服务端真实下发 skip_model_request；规范化为 camelCase 供 Host 判定。
  if (typeof record.skip_model_request === "boolean") {
    captcha.skipModelRequest = record.skip_model_request;
  } else if (typeof record.skipModelRequest === "boolean") {
    captcha.skipModelRequest = record.skipModelRequest;
  }
  return captcha;
}

export function parseClientConfigSnapshot(payload: unknown): ClientConfigSnapshot {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid public client config response");
  return {
    pluginStoreOrder: parsePluginStoreOrder(parsed.data.data?.configs?.pluginStoreOrder),
    captcha: parseCaptchaConfig(parsed.data.data?.configs?.captcha),
  };
}
