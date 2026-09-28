import {
  attachLocalHostServicePort,
  type LocalHostAttachment,
  type RelayHostMessagePort,
  type RelayHostProcess,
} from "./relayHostAttachment.js";
import { createRelayRpcBridge, type RelayRpcBridge } from "./relayRpcBridge.js";
import { type RelayTransportFrame } from "./relayFrameCodec.js";
import {
  createRelayWorkspaceBridge,
  listDefaultRelayBridgeChannels,
  type RelayWorkspaceBridge,
} from "./relayWorkspaceBridge.js";
import { buildBridgeDescriptor, mapRelayBridgeFailureReason } from "./relayManagerSupport.js";
import { type RelayWorkspaceTarget } from "./relayControlPlane.js";
import { describeExternalRelayAuthForLog } from "./relayProtocol.js";
import type { RelaySendResult } from "./relayTransportContract.js";

// 一条终端桥的装配：新的 Host attachment + rpc-frame 协议 + 全量频道代理。
//
// 为什么每个终端一条独立 attachment：Host 的一个 MessagePort 上只能有一个 ChannelClient，
// 控制面（列举 workspace/task）与终端代理各自建一条端口，避免两个 client 在同一端口上
// 交错收发把 RPC 帧搅乱。
//
// attachment 目前只走 `scope.kind === "local"`。远程 workspace 要改成按目标分派到
// `desktopRemoteSessions.attachRemoteWorkspaceSessionHost`（发行版 `attachWorkspaceHost` 的
// local/remote 两条分支），前置条件是本窗口远程 workspace 能被列举，见 spec「尚未处理」清单。

export interface RelayBridgeHandle {
  /** 会话用它判定「是不是当前桥」：rpc-frame 与传输层故障都只认最近建立的那一条。 */
  bridgeSessionId: string;
  handleFrame: (payload: unknown) => void;
  dispose: () => void;
  /** 传输层故障时对外通告桥降级，触发终端 recoverConnection。 */
  degrade: (detail: string) => void;
  /** 桥所在的 workspace，用于会话主目标推导（对齐发行版 `getRuntimeWorkspaceTarget`）。 */
  target: RelayWorkspaceTarget;
  /** 终端建桥时指定的 task，用于 `activeTaskId` 回退链。 */
  initialTaskId?: string;
}

export interface OpenRelayBridgeDeps {
  windowId: number;
  getHostProcess: (windowId: number) => RelayHostProcess | undefined;
  createMessageChannel: () => { port1: RelayHostMessagePort; port2: RelayHostMessagePort };
  /**
   * 终端请求的 workspaceKey → 桌面目标。必须与 bootstrap / workspace-list 用同一份列表，
   * 否则会出现「列表里有但建桥说没有」这类只有远程身份才会暴露的分歧。
   */
  resolveTarget: (workspaceKey: string) => RelayWorkspaceTarget | undefined;
  sendPayload: (payload: unknown) => RelaySendResult;
  getDeviceSid: () => string | undefined;
  logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** 带码的建桥失败：reason 由 mapRelayBridgeFailureReason 从 code 推出，不在各处写死。 */
function bridgeFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * 建桥。失败时按原因回 `workspace-bridge-error` 并返回 undefined：终端靠 reason 决定是
 * 提示重连桌面、重开工作区还是放弃，写死一种会让三种现场看起来一模一样。
 */
export function openRelayBridge(
  deps: OpenRelayBridgeDeps,
  payload: Record<string, unknown>,
  bridgeSessionId: string,
): RelayBridgeHandle | undefined {
  const workspaceKey = String(payload.workspaceKey ?? "");
  const bridgeGeneration =
    typeof payload.bridgeGeneration === "number" ? payload.bridgeGeneration : undefined;
  const recoveryId =
    typeof payload.recoveryId === "string" && payload.recoveryId.trim()
      ? payload.recoveryId
      : undefined;

  // 按创建顺序登记可回收资源；中途失败时反序收回，成功后清空登记并把回收权交给 handle.dispose。
  const created: Array<{ dispose: (reason?: Error) => void }> = [];
  try {
    const host = deps.getHostProcess(deps.windowId);
    if (!host) {
      throw bridgeFailure(
        "DESKTOP_HOST_MISSING",
        `未找到桌面窗口 host process，windowId=${deps.windowId}`,
      );
    }
    const target = deps.resolveTarget(workspaceKey);
    if (!target) {
      throw new Error("目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge。");
    }
    // 描述符先行：远程目标缺 identity/remoteSessionId 时在这里就失败，不留下没有出口的 attachment。
    const bridge = buildBridgeDescriptor(payload, target, bridgeSessionId);
    // handle.initialTaskId 复用描述符的判定结果，不再各自 `typeof payload.taskId === "string"`：
    // 它会被塞进 workspace-list-response 的 activeTaskId（终端同一条 `trim().min(1)` 约束），
    // 空白值当有效位置回给终端会让整帧被静默丢弃。
    const initialTaskId = bridge.initialTaskId;

    const rpcBridge: RelayRpcBridge = createRelayRpcBridge({
      context: { bridgeSessionId, bridgeGeneration },
      sendFrame: (frame) => deps.sendPayload(frame).kind === "sent",
      onDegraded: (event) => {
        deps.logger.warn("[web-remote-control] bridge degraded", { bridgeSessionId, ...event });
        // 终端靠这条帧决定是否走 recoverConnection；detail 不在线上 schema 内，只进日志。
        deps.sendPayload({
          zcode_type: "bridge-degraded",
          bridgeSessionId,
          ...(bridgeGeneration === undefined ? {} : { bridgeGeneration }),
          reason: event.reasonCode,
        });
      },
    });
    created.push(rpcBridge);

    const attachment: LocalHostAttachment = attachLocalHostServicePort({
      host,
      createMessageChannel: deps.createMessageChannel,
    });
    created.push(attachment);

    const workspaceBridge: RelayWorkspaceBridge = createRelayWorkspaceBridge({
      hostPort: attachment.port,
      relayProtocol: rpcBridge.protocol,
      channelNames: listDefaultRelayBridgeChannels(),
    });
    created.push(workspaceBridge);

    deps.sendPayload({
      zcode_type: "workspace-bridge-ready",
      requestId: payload.requestId,
      bridgeSessionId,
      ...(bridgeGeneration === undefined ? {} : { bridgeGeneration }),
      bridge,
    });
    // 与发行版时序一致：桥与频道都就位之后才放行 Initialize。
    workspaceBridge.open();

    deps.logger.info("[web-remote-control] workspace bridge active", {
      windowId: deps.windowId,
      bridgeSessionId,
      kind: target.kind,
      ...describeExternalRelayAuthForLog({ deviceSid: deps.getDeviceSid() }),
    });

    // 从这里起不再有可抛出的装配步骤：登记清空，资源由 handle.dispose 收回。
    created.length = 0;
    return {
      bridgeSessionId,
      handleFrame: (frame) => rpcBridge.handleFrame(frame as RelayTransportFrame),
      degrade: (detail) => rpcBridge.degrade("rpc-transport-fault", detail),
      dispose: () => {
        workspaceBridge.dispose();
        attachment.dispose();
        rpcBridge.dispose();
      },
      target,
      ...(initialTaskId ? { initialTaskId } : {}),
    };
  } catch (error) {
    // 反序收回：先停频道代理，再撤 Host attachment，最后释放 relay 侧协议。
    // 否则 Host 注册表会留着一条对端已经消失的 attachment。
    for (const resource of created.reverse()) {
      try {
        resource.dispose();
      } catch {
        // 单个资源回收失败不影响其余回收；泄漏面只到这一条桥为止。
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    deps.logger.warn("[web-remote-control] workspace bridge failed", {
      windowId: deps.windowId,
      bridgeSessionId,
      workspaceKey,
      error: detail,
    });
    deps.sendPayload({
      zcode_type: "workspace-bridge-error",
      requestId: payload.requestId,
      bridgeSessionId,
      ...(bridgeGeneration === undefined ? {} : { bridgeGeneration }),
      ...(recoveryId === undefined ? {} : { recoveryId }),
      reason: mapRelayBridgeFailureReason(error),
      error: detail,
    });
    return undefined;
  }
}
