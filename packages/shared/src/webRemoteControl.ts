import { z } from "zod";

// 移动端远程控制（外部中继）的跨进程共享类型。
// 放 shared 是因为它同时被 main（状态产出）、preload（透传）与 renderer（展示）使用；
// 任何一层自己重复声明都会导致字段漂移。

export const webRemoteControlStateSchema = z.enum([
  "disabled",
  "idle",
  "connecting",
  "registering",
  "authenticating",
  "waiting_terminal",
  "pairing",
  "paired",
  "error",
]);

export type WebRemoteControlState = z.infer<typeof webRemoteControlStateSchema>;

/**
 * 终端上报的连接设备信息。只保留界面真正会读的两个字段：`browserPlatform`（终端取
 * `navigator.platform`，所以电脑浏览器会显示成 Win32）与 `name`。
 * 发行版的 deviceInfo 还带 userAgent / viewport / screen / timezone 等，本仓库不展示
 * 就不收集——那是远端浏览器塞进来的用户环境数据。
 */
export const webRemoteControlDeviceInfoSchema = z.looseObject({
  name: z.string().optional(),
  browserPlatform: z.string().optional(),
});

export type WebRemoteControlDeviceInfo = z.infer<typeof webRemoteControlDeviceInfoSchema>;

/** 终局失败原因；取值与终端侧 `webRemoteControl.failure.*` 的键一一对应。 */
export const webRemoteControlFailureReasonSchema = z.enum([
  "session-not-found",
  "session-expired",
  "session-conflict",
  "kicked",
  "workspace-closed",
  "desktop-disconnected",
  "invalid-mobile-connection",
  "desktop-bootstrap-timeout",
  "connection-recovery-timeout",
  "relay-unavailable",
  "unsupported-action",
  "unexpected-error",
]);

export type WebRemoteControlFailureReason = z.infer<typeof webRemoteControlFailureReasonSchema>;

export interface WebRemoteControlFailure {
  reason: WebRemoteControlFailureReason;
  message?: string;
}

export const webRemoteControlStatusSchema = z.looseObject({
  enabled: z.boolean(),
  state: webRemoteControlStateSchema,
  /** 含一次性配对口令，只在内存与界面上短暂存在，禁止写日志。 */
  pairingUrl: z.string().optional(),
  deviceSidSuffix: z.string().optional(),
  /** 当前占用配对槽位的终端设备描述，用于状态胶囊显示设备类型。 */
  deviceInfo: webRemoteControlDeviceInfoSchema.optional(),
  /** 终局失败原因；有值时界面按原因出文案，而不是笼统显示"连接失败"。 */
  failure: z
    .object({ reason: webRemoteControlFailureReasonSchema, message: z.string().optional() })
    .optional(),
  workspaceCount: z.number().int().nonnegative(),
});

export type WebRemoteControlStatus = z.infer<typeof webRemoteControlStatusSchema>;

export const WEB_REMOTE_CONTROL_DEFAULT_STATUS: WebRemoteControlStatus = {
  enabled: false,
  state: "disabled",
  workspaceCount: 0,
};
