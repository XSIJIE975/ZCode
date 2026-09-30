import type {
  AiSdkModelExecutionConfig,
  AiSdkNetworkConfig,
  CodingPlanSignatureRuntimeConfig,
  EnvRecord,
} from "@zcode/adapters/model";
import {
  resolveRuntimeZCodeEnv,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_APP_VERSION_ENV,
} from "@zcode/shared";
import {
  createRuntimePlatformHeaders,
  normalizePrintableHeaderValue,
} from "./runtime-platform-headers.js";

export type ModelProviderSourceTitle = "cli" | "electron";

interface RuntimeExecutionConfigOptions {
  appVersion?: string;
  network?: AiSdkNetworkConfig;
  sourceTitle?: ModelProviderSourceTitle;
}

/** feature gate 查询路径（挂在 ZCode 平台端点 origin 上）。 */
const CODING_PLAN_SIGNATURE_CONFIG_PATH = "/api/v1/agent/configs";

export function createRuntimeAiSdkModelExecutionConfig(
  env: EnvRecord = process.env,
  options: RuntimeExecutionConfigOptions = {},
): AiSdkModelExecutionConfig {
  const network = normalizeAiSdkNetworkConfig(options.network);
  return {
    defaultHeaders: buildCliZCodeSourceHeaders(env, options),
    // 官方 Coding Plan 客户端签名配置：gate 地址跟随 ZCODE_BASE_URL / ZCODE_ENDPOINT_ORIGIN，
    // 查询头复用与模型请求一致的来源头；签名本身只在 requiresClientRequestSigning 命中时启用。
    codingPlanSignature: createCodingPlanSignatureConfig(env, options),
    env,
    ...(network ? { network } : {}),
  };
}

function createCodingPlanSignatureConfig(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion" | "sourceTitle">,
): CodingPlanSignatureRuntimeConfig {
  const path = CODING_PLAN_SIGNATURE_CONFIG_PATH.startsWith("/")
    ? CODING_PLAN_SIGNATURE_CONFIG_PATH
    : `/${CODING_PLAN_SIGNATURE_CONFIG_PATH}`;
  return {
    configUrl: `${resolveRuntimeZCodeEndpointOrigin(env)}${path}`,
    headers: buildCliZCodeSourceHeaders(env, options),
  };
}

function normalizeAiSdkNetworkConfig(
  network: AiSdkNetworkConfig | undefined,
): AiSdkNetworkConfig | undefined {
  if (!network?.caCertFile && !network?.httpProxy && !network?.noProxy) return undefined;
  return {
    ...(network.caCertFile ? { caCertFile: network.caCertFile } : {}),
    ...(network.httpProxy ? { httpProxy: network.httpProxy } : {}),
    ...(network.noProxy ? { noProxy: network.noProxy } : {}),
  };
}

function buildCliZCodeSourceHeaders(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion" | "sourceTitle"> = {},
): Record<string, string> {
  const sourceTitle = options.sourceTitle ?? detectDefaultProviderSourceTitle();
  const appVersion = resolveAppVersionForHeaders(env, options);
  const locale = normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().locale);
  const timezone = normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return {
    "HTTP-Referer": resolveRuntimeZCodeEndpointOrigin(env),
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    "X-Release-Channel": resolveRuntimeZCodeEnv(env),
    "X-Client-Language": locale ?? "unknown",
    "X-Client-Timezone": timezone ?? "unknown",
    "X-ZCode-Agent": "glm",
    ...createRuntimePlatformHeaders(),
  };
}

function resolveAppVersionForHeaders(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion">,
): string | undefined {
  return normalizePrintableHeaderValue(env[ZCODE_APP_VERSION_ENV] ?? options.appVersion);
}

function detectDefaultProviderSourceTitle(): ModelProviderSourceTitle {
  return process.argv.includes("app-server") || process.argv.includes("agent-server")
    ? "electron"
    : "cli";
}
