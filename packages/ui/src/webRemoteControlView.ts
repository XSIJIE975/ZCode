import { useEffect, useState } from "react";
import { WEB_REMOTE_CONTROL_DEFAULT_STATUS, type WebRemoteControlStatus } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
// 设备端状态到展示语义的唯一映射。侧边栏入口（图标配色 + 提示文案）和弹窗内的状态卡
// 必须读同一份，否则会出现「图标说已连接、卡片说等待手机」这种自相矛盾的显示。

export type WebRemoteControlViewStatus =
  | "idle"
  | "starting"
  | "connecting"
  | "running"
  | "active"
  | "error";

const VIEW_STATUS_BY_STATE: Record<WebRemoteControlStatus["state"], WebRemoteControlViewStatus> = {
  disabled: "idle",
  idle: "idle",
  connecting: "starting",
  registering: "starting",
  authenticating: "starting",
  waiting_terminal: "running",
  pairing: "connecting",
  paired: "active",
  error: "error",
};

export function webRemoteControlViewStatusOf(
  status: WebRemoteControlStatus | undefined,
): WebRemoteControlViewStatus {
  return VIEW_STATUS_BY_STATE[status?.state ?? "disabled"];
}

/** 入口图标的配色与提示文案；警示色统一用 warning，成功用 success，失败用 destructive。 */
export function webRemoteControlTriggerView(status: WebRemoteControlStatus | undefined): {
  iconClassName: string;
  tooltipId: string;
} {
  switch (webRemoteControlViewStatusOf(status)) {
    case "error":
      return {
        iconClassName: "text-destructive",
        tooltipId: "webRemoteControl.triggerStatus.error",
      };
    case "active":
      return {
        iconClassName: "text-success",
        tooltipId: "webRemoteControl.triggerStatus.connected",
      };
    case "starting":
      return {
        iconClassName: "text-warning",
        tooltipId: "webRemoteControl.triggerStatus.starting",
      };
    case "connecting":
      return {
        iconClassName: "text-warning",
        tooltipId: "webRemoteControl.triggerStatus.connecting",
      };
    case "running":
      return {
        iconClassName: "text-warning",
        tooltipId: "webRemoteControl.triggerStatus.waiting",
      };
    default:
      return {
        iconClassName: "text-foreground-subtle",
        tooltipId: "webRemoteControl.triggerStatus.idle",
      };
  }
}

/** 终局失败原因 → 本地化文案 key。取值与发行版 failure 枚举一一对应。 */
const FAILURE_MESSAGE_KEY: Record<string, string> = {
  "session-not-found": "webRemoteControl.failure.sessionNotFound",
  "session-expired": "webRemoteControl.failure.sessionExpired",
  "session-conflict": "webRemoteControl.failure.sessionConflict",
  kicked: "webRemoteControl.failure.kicked",
  "workspace-closed": "webRemoteControl.failure.workspaceClosed",
  "desktop-disconnected": "webRemoteControl.failure.desktopDisconnected",
  "invalid-mobile-connection": "webRemoteControl.failure.invalidMobileConnection",
  "desktop-bootstrap-timeout": "webRemoteControl.failure.desktopBootstrapTimeout",
  "connection-recovery-timeout": "webRemoteControl.failure.connectionRecoveryTimeout",
  "relay-unavailable": "webRemoteControl.failure.relayUnavailable",
  "unsupported-action": "webRemoteControl.failure.unsupportedAction",
  "unexpected-error": "webRemoteControl.failure.unexpectedError",
};

export function webRemoteControlFailureMessageId(reason: string): string {
  return FAILURE_MESSAGE_KEY[reason] ?? "webRemoteControl.failure.unexpectedError";
}

/**
 * 状态胶囊文案。优先级与发行版一致：终端上报的浏览器平台（电脑浏览器会是 Win32）
 * → 设备名 → 按连接状态兜底。设备信息是终端连上后才随 view-state 帧到达的，
 * 所以刚连上的一瞬间可能还是兜底文案。
 */
export function webRemoteControlStatusTagText(
  status: WebRemoteControlStatus | undefined,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  const device = status?.deviceInfo;
  const fromDevice = device?.browserPlatform?.trim() || device?.name?.trim();
  if (fromDevice) return fromDevice;
  switch (webRemoteControlViewStatusOf(status)) {
    case "active":
      return formatMessage({ id: "webRemoteControl.statusTag.phone" });
    case "idle":
      return formatMessage({ id: "webRemoteControl.status.idle" });
    case "error":
      return formatMessage({ id: "webRemoteControl.status.error" });
    default:
      return formatMessage({ id: "webRemoteControl.statusTag.ready" });
  }
}

/** 兜底轮询间隔，与发行版弹窗和入口 hook 的 1e3 一致。 */
const WEB_REMOTE_CONTROL_POLL_INTERVAL_MS = 1_000;

function isSameWebRemoteControlStatus(
  previous: WebRemoteControlStatus,
  next: WebRemoteControlStatus,
): boolean {
  return (
    previous.enabled === next.enabled &&
    previous.state === next.state &&
    previous.pairingUrl === next.pairingUrl &&
    previous.deviceSidSuffix === next.deviceSidSuffix &&
    previous.workspaceCount === next.workspaceCount &&
    previous.deviceInfo?.name === next.deviceInfo?.name &&
    previous.deviceInfo?.browserPlatform === next.deviceInfo?.browserPlatform &&
    previous.failure?.reason === next.failure?.reason &&
    previous.failure?.message === next.failure?.message
  );
}

/**
 * 状态订阅的唯一入口。Web 构建没有设备端，`supported` 为 false 时调用方应整块不渲染，
 * 而不是显示一个点了没反应的按钮。
 *
 * 除事件推送外还带 1 秒兜底轮询（与发行版 useWebRemoteControlStatus 的 intervalMs=1e3 一致）：
 * main 只在它自己感知的变化上广播，终端侧的连接推进、配对超时这类事实可能整条漏推，
 * 界面就会停在一个已经不对的档位上。轮询只是**重新拉同一份 main 侧状态**，
 * 状态所有者仍然只有 Desktop Main，这里不产生第二份真相。
 * 侧边栏入口与弹窗内的卡片共用本 hook，所以轮询只写这一处。
 */
export function useWebRemoteControlStatus(): {
  status: WebRemoteControlStatus;
  supported: boolean;
  setStatus: (next: WebRemoteControlStatus) => void;
} {
  const platform = usePlatform();
  const [status, setStatus] = useState<WebRemoteControlStatus>(WEB_REMOTE_CONTROL_DEFAULT_STATUS);
  const supported = typeof platform.enableWebRemoteControl === "function";

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    // IPC 每次都返回新对象，不做等值判断的话每秒都会重渲染入口和整张卡片。
    // 比较集按本仓库状态面实际有的字段来：发行版比的是 mobileViewState / mobileDeviceInfo 的全字段，
    // 而这里的 deviceInfo 只留 name 与 browserPlatform，pairingUrl 参与比较但不落日志。
    const applyStatus = (next: WebRemoteControlStatus) => {
      if (cancelled) return;
      setStatus((current) => (isSameWebRemoteControlStatus(current, next) ? current : next));
    };
    const sync = async () => {
      try {
        const next = await platform.getWebRemoteControlStatus?.();
        if (next) applyStatus(next);
      } catch (error) {
        // 每秒一次的兜底拉取失败属可预期噪声（窗口正在关闭、会话刚被回收），
        // 用 debug 不落盘；真正阻断流程的错误由 enable/disable/reset 的调用侧处理。
        logger.debug("[useWebRemoteControlStatus] 同步远控状态失败", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void sync();
    const unsubscribe = platform.onWebRemoteControlStatusChanged?.(applyStatus);
    const timer = window.setInterval(() => void sync(), WEB_REMOTE_CONTROL_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [platform, supported]);

  return { status, supported, setStatus };
}
