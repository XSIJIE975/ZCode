import { PlatformChannels } from "@zcode/shared";
import { EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY } from "./relayProtocol.js";
import type { WebRemoteControlManager } from "./relayManager.js";
import type { WebRemoteControlStatus } from "@zcode/shared";

// 远控的 main ↔ renderer IPC 面。
// 通道名放本模块而不是 shared/channels.ts：它是 main 私有的控制面，
// 不进 Host 的 ServiceChannels 注册表，也不被 UI 直接当服务代理使用。

// 通道名统一取 PlatformChannels，避免 preload / main 两处各写一份字符串。
export const WebRemoteControlChannels = {
  Enable: PlatformChannels.WebRemoteControlEnable,
  Disable: PlatformChannels.WebRemoteControlDisable,
  Status: PlatformChannels.WebRemoteControlStatus,
  ResetPairing: PlatformChannels.WebRemoteControlResetPairing,
  StatusChanged: PlatformChannels.WebRemoteControlStatusChanged,
} as const;

export const RELAY_PASS_HASH_CREDENTIAL_KEY = EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY;

export interface WebRemoteControlIpcMainLike {
  handle(channel: string, handler: (event: { sender: unknown }) => unknown): void;
}

export interface WebRemoteControlIpcOptions {
  ipcMain: WebRemoteControlIpcMainLike;
  manager: WebRemoteControlManager;
  /** 以发送者 webContents 反查窗口 id，避免 renderer 伪造 windowId 控制别的窗口。 */
  resolveWindowId: (sender: unknown) => number | undefined;
  send: (webContentsId: number, channel: string, payload: WebRemoteControlStatus) => void;
}

export function registerWebRemoteControlIpc(options: WebRemoteControlIpcOptions): void {
  const { ipcMain, manager } = options;

  const requireWindowId = (sender: unknown): number => {
    const windowId = options.resolveWindowId(sender);
    if (typeof windowId !== "number") {
      throw new Error("web remote control: 无法解析调用方窗口");
    }
    return windowId;
  };

  ipcMain.handle(WebRemoteControlChannels.Enable, async (event) => {
    const windowId = requireWindowId(event.sender);
    const status = await manager.enable(windowId);
    options.send(windowId, WebRemoteControlChannels.StatusChanged, status);
    return status;
  });

  ipcMain.handle(WebRemoteControlChannels.Disable, (event) => {
    const windowId = requireWindowId(event.sender);
    manager.disable(windowId, "renderer-request");
    const status = manager.getStatus(windowId);
    options.send(windowId, WebRemoteControlChannels.StatusChanged, status);
    return status;
  });

  ipcMain.handle(WebRemoteControlChannels.ResetPairing, async (event) => {
    const windowId = requireWindowId(event.sender);
    // 二维码含一次性配对口令，泄漏即等价凭据泄漏：重置必须清凭据并重新注册。
    const status = await manager.resetPairing(windowId, "user-reset");
    options.send(windowId, WebRemoteControlChannels.StatusChanged, status);
    return status;
  });

  ipcMain.handle(WebRemoteControlChannels.Status, (event) => {
    const windowId = requireWindowId(event.sender);
    return manager.getStatus(windowId);
  });
}
