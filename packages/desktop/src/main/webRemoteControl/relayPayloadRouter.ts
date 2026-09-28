import {
  buildRelayBootstrapResult,
  buildRelayWorkspaceListResult,
  type RelayControlPlaneDeps,
  type RelayWorkspaceTarget,
} from "./relayControlPlane.js";
import { respondPlatformRequest } from "./relayManagerSupport.js";

// 终端 → 设备端的控制面路由：按 `zcode_type` 分派。
//
// 只有这里知道线上有哪些控制面消息；relayManager 负责装配会话与桥，
// 两者分开是为了让「协议分派表」能单独对着终端 zod 联合类型逐条核对。

export interface RelayPayloadRouterDeps {
  /** 只有已建立的桥才收 rpc-frame；未知 bridgeSessionId 直接丢弃。 */
  getBridge: (bridgeSessionId: string) => { handleFrame: (payload: unknown) => void } | undefined;
  sendPayload: (payload: Record<string, unknown>) => void;
  controlPlane: () => RelayControlPlaneDeps;
  openBridge: (payload: Record<string, unknown>) => void;
  /**
   * workspaceKey → 桌面目标，与 bootstrap / workspace-list 同一份列表。
   * 重连可用性判定必须走它而不是按路径比对：远程 workspace 的身份键是 workspaceIdentity，
   * 与 `workspacePath` 不是同一个值，按路径匹配会把它判成"已关闭"。
   */
  resolveTarget: (workspaceKey: string) => RelayWorkspaceTarget | undefined;
  platformHandlers?: Record<string, (args: unknown) => Promise<unknown>>;
  /** 终端切换视图时上报的位置，要存进会话，后续 bootstrap / workspace-list 才会回到用户所在处。 */
  applyMobileViewState: (viewState: unknown, deviceInfo: unknown) => void;
  logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  getDeviceSid: () => string | undefined;
}

export type RelayPayloadRouter = (raw: unknown) => void;

export function createRelayPayloadRouter(deps: RelayPayloadRouterDeps): RelayPayloadRouter {
  return (raw: unknown): void => {
    const payload = raw as Record<string, unknown>;
    const zcodeType = payload?.zcode_type as string | undefined;
    if (!zcodeType) return;

    if (zcodeType === "rpc-frame" || zcodeType === "rpc-frame-ack") {
      const bridgeSessionId = payload.bridgeSessionId;
      if (typeof bridgeSessionId === "string")
        deps.getBridge(bridgeSessionId)?.handleFrame(payload);
      return;
    }
    if (zcodeType === "bootstrap-request") {
      // 组装失败或拿不到 sid 时必须回一条 success:false：终端对 bootstrap-response 走严格
      // zod，缺字段的帧会被静默丢弃，不回应对终端来说只是"桌面端超时"。
      void buildRelayBootstrapResult(deps.controlPlane())
        .then((result) => {
          deps.sendPayload(
            result
              ? {
                  zcode_type: "bootstrap-response",
                  requestId: payload.requestId,
                  success: true,
                  result,
                }
              : {
                  zcode_type: "bootstrap-response",
                  requestId: payload.requestId,
                  success: false,
                  error: "device session not ready",
                },
          );
        })
        .catch((error: unknown) => {
          deps.sendPayload({
            zcode_type: "bootstrap-response",
            requestId: payload.requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    if (zcodeType === "workspace-list-request") {
      void buildRelayWorkspaceListResult(deps.controlPlane())
        .then((result) => {
          deps.sendPayload({
            zcode_type: "workspace-list-response",
            requestId: payload.requestId,
            success: true,
            result,
          });
        })
        .catch((error: unknown) => {
          deps.sendPayload({
            zcode_type: "workspace-list-response",
            requestId: payload.requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    if (zcodeType === "workspace-bridge-open") {
      deps.openBridge(payload);
      return;
    }
    if (zcodeType === "workspace-reconnect-request") {
      // 终端在 recoverConnection 里先探一次「这个 workspace 还在不在」，随后才用新的
      // bridgeSessionId 发 workspace-bridge-open。这里只做可用性判定，不提前建桥，
      // 否则会和紧随其后的 bridge-open 撞成两条 attachment。
      const workspaceKey = String(payload.workspaceKey ?? "");
      const available = Boolean(deps.resolveTarget(workspaceKey));
      deps.sendPayload(
        available
          ? {
              zcode_type: "workspace-reconnect-response",
              requestId: payload.requestId,
              workspaceKey,
              success: true,
            }
          : {
              zcode_type: "workspace-reconnect-response",
              requestId: payload.requestId,
              workspaceKey,
              success: false,
              error: "workspace-closed",
            },
      );
      return;
    }
    if (zcodeType === "platform-request") {
      void respondPlatformRequest({
        payload,
        sendPayload: deps.sendPayload,
        handlers: deps.platformHandlers,
      });
      return;
    }
    if (zcodeType === "mobile-view-state-update") {
      deps.applyMobileViewState(payload.viewState, payload.deviceInfo);
      return;
    }
    if (zcodeType === "mobile-diagnostic") {
      // 手机侧的连接自述（关码、是否干净关闭、失败原因等）。设备端是唯一能看到它的人，
      // 不落日志的话，手机端报"连不上"时这边完全无线索。
      deps.logger.info("[web-remote-control] mobile diagnostic", {
        session: deps.getDeviceSid(),
        event: payload.event,
        state: payload.state,
        previousState: payload.previousState,
        pairStatus: payload.pairStatus,
        closeCode: payload.closeCode,
        closeReason: payload.closeReason,
        wasClean: payload.wasClean,
        wasPaired: payload.wasPaired,
        failureReason: payload.failureReason,
      });
      return;
    }
    // telemetry-report 是终端埋点回传，发行版转给自己的遥测管线；本仓库不把远端传入的事件
    // 灌进用户遥测上报链路，因此只静默接收。
  };
}
