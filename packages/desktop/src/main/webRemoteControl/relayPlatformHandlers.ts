import type {
  CreateTempTextAttachmentRequest,
  LoadCliMcpFromUserDirectoryRequest,
  MigrateLegacyCommonMcpRequest,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import {
  isDockerDaemonAvailable,
  listAvailableDockerContainers,
  listAvailableWSLDistros,
  listSSHConfigAliases,
} from "../desktopRuntimeEnv.js";
import { createTempTextAttachment } from "../tempTextAttachment.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "../mcpUserDirectory/index.js";

// 终端 `platform-request` 的方法白名单。终端只承认这 8 个 method，
// 其余一律由 relayManager 回 `success:false`，不会走到这里。
//
// 这些能力全部读的是「桌面宿主本机」的事实（Docker/WSL/SSH config、用户目录 MCP 配置、
// 剪贴板长文本落盘），手机侧没有宿主，只能经 relay 请桌面代跑，因此实现直接复用桌面 IPC
// 的同一批函数，避免出现第二套口径。

export const RELAY_PLATFORM_REQUEST_METHODS = [
  "isDockerAvailable",
  "listWSLDistros",
  "listDockerContainers",
  "listSSHConfigAliases",
  "createTempTextAttachment",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
] as const;

export type RelayPlatformRequestMethod = (typeof RELAY_PLATFORM_REQUEST_METHODS)[number];

export type RelayPlatformHandlers = Record<
  RelayPlatformRequestMethod,
  (args: unknown) => Promise<unknown>
>;

/** args 来自远端，只有对象/缺省两种形态可以透传给实现；其余按空参数处理。 */
function asPayload<T>(args: unknown): T | undefined {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as T)
    : undefined;
}

export function createRelayPlatformHandlers(): RelayPlatformHandlers {
  return {
    isDockerAvailable: async () => isDockerDaemonAvailable(),
    listWSLDistros: async () => listAvailableWSLDistros(),
    listDockerContainers: async () => listAvailableDockerContainers(),
    listSSHConfigAliases: async () => listSSHConfigAliases(),
    // 手机粘贴的长文本要落成宿主临时文件才能进 composer，与桌面 IPC 共用同一实现。
    createTempTextAttachment: async (args) =>
      createTempTextAttachment(asPayload<CreateTempTextAttachmentRequest>(args) ?? { text: "" }),
    loadMcpFromUserDirectory: async (args) =>
      loadCliMcpFromUserDirectory(asPayload<LoadCliMcpFromUserDirectoryRequest>(args)),
    // 与桌面 IPC 同口径：写失败是「结果」而不是「协议错误」，回 {success:false,error}。
    saveMcpToUserDirectory: async (args) => {
      const payload = asPayload<SaveCliMcpToUserDirectoryRequest>(args);
      if (!payload) return { success: false, error: "missing payload" };
      try {
        await saveCliMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    migrateLegacyCommonMcp: async (args) =>
      migrateLegacyCommonMcp(asPayload<MigrateLegacyCommonMcpRequest>(args)),
  };
}
