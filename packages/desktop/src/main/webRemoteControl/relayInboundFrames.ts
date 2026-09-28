import type { WebRemoteControlFailureReason } from "@zcode/shared";
import type { ExternalRelayDeviceState } from "./relayProtocol.js";
import type { RelayAuthMaterial } from "./relayTransportContract.js";

// 中继入站帧的解析与错误码决策表。
// 决策表只做纯函数映射，副作用（关链路、重连、上抛）留在传输层，避免出现第二套状态写入路径。

export type RelayInboundFrame =
  | { kind: "registerAck"; deviceSid: string }
  | { kind: "authChallenge"; nonce: string }
  | { kind: "pairStatus"; pairStatus: string | undefined }
  | { kind: "data"; payload: unknown }
  | { kind: "relayError"; code: string | undefined; message: string | undefined }
  | { kind: "ignored" };

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 解析失败或类型未知都归为 ignored：畸形帧不能让设备端整体失联。 */
export function parseRelayInboundFrame(raw: string): RelayInboundFrame {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { kind: "ignored" };
  }
  switch (frame.type) {
    case "device_register_ack":
      return { kind: "registerAck", deviceSid: readString(frame.device_sid) ?? "" };
    case "auth_challenge":
      return { kind: "authChallenge", nonce: readString(frame.nonce) ?? "" };
    case "auth_ack":
    case "pair_status_ack":
      return { kind: "pairStatus", pairStatus: readString(frame.pair_status) };
    case "data":
      return { kind: "data", payload: frame.payload };
    case "error":
      return {
        kind: "relayError",
        code: readString(frame.code),
        message: readString(frame.message),
      };
    default:
      return { kind: "ignored" };
  }
}

export type RelayErrorAction =
  | { kind: "closeForReconnect"; message?: string }
  | { kind: "reRegisterWithSamePassHash" }
  | { kind: "waitAfterRelayError"; message?: string }
  | { kind: "recoverableError"; message?: string }
  | { kind: "reportErrorOnly"; message?: string }
  | { kind: "terminalError"; reason: WebRemoteControlFailureReason; message?: string };

export interface RelayErrorDecisionInput {
  code: string | undefined;
  message: string | undefined;
  state: ExternalRelayDeviceState;
  auth: RelayAuthMaterial | undefined;
  invalidPersistedRetryUsed: boolean;
}

const isAlive = (state: ExternalRelayDeviceState): boolean =>
  state === "paired" || state === "waiting_terminal";

/**
 * 错误码 → 动作。逐条对应发行版 handleRelayError 的分支顺序：
 * KICKED 关链路让 close 重连；AUTH_FAILED 对持久化凭据只回退一次（沿用同一份 passHash
 * 重新注册）；INTERNAL 在会话仍活着时只是"暂时配不上对"；WRONG_PARAM 在活跃期只上报；
 * 其余一律终局。
 */
export function resolveRelayErrorAction(input: RelayErrorDecisionInput): RelayErrorAction {
  const { code, message, state, auth, invalidPersistedRetryUsed } = input;
  if (code === "KICKED") return { kind: "closeForReconnect", message };
  if (code === "AUTH_FAILED") {
    if (auth?.mode === "persisted" && !invalidPersistedRetryUsed)
      return { kind: "reRegisterWithSamePassHash" };
    // 回退额度已用尽还是失败，说明不是"旧 sid"问题：终局，不再重连。
    return { kind: "terminalError", reason: "relay-unavailable", message };
  }
  if (code === "INTERNAL") {
    return isAlive(state)
      ? { kind: "waitAfterRelayError", message }
      : { kind: "recoverableError", message };
  }
  if (code === "WRONG_PARAM" && isAlive(state)) return { kind: "reportErrorOnly", message };
  return { kind: "terminalError", reason: "unexpected-error", message: message ?? code };
}

/** 决策结果的落地入口：副作用全部由传输层提供，这里只负责按分支派发。 */
export interface RelayErrorEffects {
  onKicked(message: string | undefined): void;
  onReRegisterWithSamePassHash(): void;
  onWaitAfterRelayError(message: string | undefined): void;
  onRecoverableError(message: string | undefined): void;
  onErrorOnly(message: string | undefined): void;
  onTerminalError(reason: WebRemoteControlFailureReason, message: string | undefined): void;
}

export function applyRelayErrorAction(action: RelayErrorAction, effects: RelayErrorEffects): void {
  switch (action.kind) {
    case "closeForReconnect":
      effects.onKicked(action.message);
      return;
    case "reRegisterWithSamePassHash":
      effects.onReRegisterWithSamePassHash();
      return;
    case "waitAfterRelayError":
      effects.onWaitAfterRelayError(action.message);
      return;
    case "recoverableError":
      effects.onRecoverableError(action.message);
      return;
    case "reportErrorOnly":
      effects.onErrorOnly(action.message);
      return;
    case "terminalError":
      effects.onTerminalError(action.reason, action.message);
      return;
  }
}
