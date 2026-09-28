import type { WebRemoteControlFailureReason } from "@zcode/shared";
import type { ExternalRelayDeviceState, ExternalRelayMeta } from "./relayProtocol.js";

// 外部中继设备端传输层的对外契约：常量、注入点与返回形态。
// 与实现（relayDeviceTransport.ts）分开，便于上层只依赖契约而不牵动状态机。

export const RELAY_PENDING_OUTBOUND_LIMIT = 50;
/** 待发帧的最长滞留时间；超时整批丢弃，避免把过期 RPC 回执推给已重连的终端。 */
export const RELAY_PENDING_OUTBOUND_TTL_MS = 5_000;
export const RELAY_SOCKET_OPEN = 1;
/** 首个过期 waiting 后给多久的恢复窗；到期仍未 matched 才重连。 */
export const RELAY_STALE_WAITING_RECOVERY_DELAY_MS = 15_000;

/** 结构化的 WebSocket 依赖，便于注入与测试，同时把外部 I/O 收在 adapter 边界。 */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: { toString(encoding?: string): string }) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "close",
    listener: (code: number, reason: { toString(encoding?: string): string }) => void,
  ): void;
}

export type RelaySocketFactory = (
  url: string,
  options: { perMessageDeflate: boolean; headers: Record<string, string> },
) => RelaySocket;

export interface RelayAuthMaterial {
  mode: "register" | "persisted";
  deviceSid?: string;
  passHash: string;
}

export interface RelayDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  meta: ExternalRelayMeta;
  createSocket: RelaySocketFactory;
  /** 返回本次连接使用的凭据；register 模式下上层负责持久化 onRegisteredAuth 的结果。 */
  resolveAuth: () => RelayAuthMaterial;
  onRegisteredAuth: (auth: { deviceSid: string; passHash: string }) => void;
  onClearAuth: (reason: string) => void;
  onData: (payload: unknown) => void;
  /**
   * 传输层故障（如物理帧超限）。发行版用它把 `remote.rpcFrame.envelopeTooLarge`
   * 转成桥的 degraded 信号，终端据此走 recoverConnection；没有这条上报，
   * 手机侧只会表现为"连上但偶发丢帧/卡流"且不自愈。
   */
  onTransportFault?: (reason: string) => void;
  /** 终局失败（不再重连）的原因，上层据此把状态面切到 error 并给出可读文案。 */
  onTransportFailure?: (failure: {
    reason: WebRemoteControlFailureReason;
    message?: string;
  }) => void;
  onStateChange?: (state: ExternalRelayDeviceState) => void;
  logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface RelaySendResult {
  kind: "sent" | "unavailable" | "oversize";
  bytes: number;
}

export interface RelayDeviceTransport {
  start: () => void;
  stop: (reason?: string) => void;
  /** 仅 paired 且无待恢复的过期 waiting 时可发；否则报文进待发队列。 */
  sendPayload: (payload: unknown) => RelaySendResult;
  getState: () => ExternalRelayDeviceState;
  getDeviceSid: () => string | undefined;
}
