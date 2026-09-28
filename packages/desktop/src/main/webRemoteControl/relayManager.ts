import { connectViaMessagePort } from "@zcode/client";
import type {
  WebRemoteControlDeviceInfo,
  WebRemoteControlFailure,
  WebRemoteControlState,
  WebRemoteControlStatus,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  createExternalRelayCredentials,
  describeExternalRelayAuthForLog,
  type ExternalRelayCredentials,
} from "./relayProtocol.js";
import { createRelayDeviceTransport } from "./relayDeviceTransport.js";
import { type RelaySocket } from "./relayTransportContract.js";
import {
  attachLocalHostServicePort,
  type RelayHostMessagePort,
  type RelayHostProcess,
} from "./relayHostAttachment.js";
import { openRelayBridge, type RelayBridgeHandle } from "./relayBridgeSession.js";
import {
  buildRelayWorkspaceListResult,
  buildRelayWorkspaceListPushSignature,
  findRelayWorkspaceTarget,
  listRelayWorkspaces,
  type RelayControlPlaneDeps,
  type RelayViewState,
  type RelayWorkspaceTarget,
} from "./relayControlPlane.js";
import { createRelayPayloadRouter, type RelayPayloadRouter } from "./relayPayloadRouter.js";
import {
  buildRelayMeta,
  createRelayPairingUrlBuilder,
  buildRelayStatus,
  clearRelayMobileGrace,
  disposeRelaySession,
  holdRelayMobileGrace,
  loadPairedRelayCredential,
  applyRelayTerminalState,
  resolveRelayRuntimeTarget,
  saveStartupRestoreContext,
  type RelayStartupRestoreStorage,
} from "./relayManagerSupport.js";
import { requestRelayWorkspaceListPush } from "./relayWorkspaceListPush.js";
import { createRelayStartupRestorer } from "./relayStartupRestore.js";

// 移动端远控的 main 侧装配：一条 relay 设备端连接 + 一条控制面 attachment +
// 每个终端桥一条独立 attachment。
//
// 为什么用两条 attachment：Host 的一个 MessagePort 上只能有一个 ChannelClient，
// 控制面（列举 workspace/task）与终端代理（全量频道转发）各自建一条端口，
// 避免两个 client 在同一端口上交错收发把 RPC 帧搅乱。

export type { WebRemoteControlState, WebRemoteControlStatus } from "@zcode/shared";
export type {
  RelayStartupRestoreContext,
  RelayStartupRestoreStorage,
} from "./relayManagerSupport.js";

export interface WebRemoteControlManagerDeps {
  getHostProcess: (windowId: number) => RelayHostProcess | undefined;
  createMessageChannel: () => { port1: RelayHostMessagePort; port2: RelayHostMessagePort };
  deviceMid: string;
  appVersion: string;
  platform: NodeJS.Platform;
  /** 终端展示的设备名，发行版取 os.hostname()。 */
  deviceName: string;
  /** 端点依赖运行时设置 zcodeEndpointOrigin，可能是异步解析，因此每个会话只解析一次。 */
  resolveRelayEndpoints: () => Promise<{ relayWsUrl: string; remoteUrl: string }>;
  createSocket: (
    url: string,
    options: { perMessageDeflate: boolean; headers: Record<string, string> },
  ) => RelaySocket;
  readPassHash: () => Promise<string | undefined>;
  savePassHash: (passHash: string) => Promise<void>;
  clearPassHash: (reason: string) => Promise<void>;
  readDeviceSid: () => Promise<string | undefined>;
  saveDeviceSid: (deviceSid: string) => Promise<void>;
  clearDeviceSid: () => Promise<void>;
  listWorkspacePaths: (windowId: number) => string[];
  /** 终端 platform-request 白名单；未提供的方法一律回 success:false。 */
  platformHandlers?: Record<string, (args: unknown) => Promise<unknown>>;
  /**
   * 启动恢复上下文。与发行版同一形态：enable 时 save、disable 时 clear，
   * 下次启动由 `tryRestoreOnWorkspacesReady` 用 load 的结果自动重新启用。
   */
  startupRestoreStorage?: RelayStartupRestoreStorage;
  logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  onStatusChanged?: (windowId: number, status: WebRemoteControlStatus) => void;
}

interface ActiveSession {
  windowId: number;
  transport: ReturnType<typeof createRelayDeviceTransport>;
  controlAccessor?: IServiceAccessor;
  controlAttachment?: { dispose(): void };
  bridges: Map<string, RelayBridgeHandle>;
  credentials: ExternalRelayCredentials;
  pairingUrl?: string;
  /** `pairingUrl` 是为哪个 deviceSid 生成的，用于识别中继换发 sid 的情况。 */
  pairingUrlSid?: string;
  state: WebRemoteControlState;
  endpoints: { relayWsUrl: string; remoteUrl: string };
  /** 会话启用时带入的 task，决定 `initialViewState` 是否存在。 */
  initialTaskId?: string;
  /** 终端最后一次上报的自身视图，用于恢复"手机看到哪儿了"。 */
  mobileViewState?: RelayViewState;
  /** 当前占用配对槽位的终端设备描述，状态胶囊靠它显示 Win32 / iPhone 这类设备类型。 */
  deviceInfo?: WebRemoteControlDeviceInfo;
  /** 终局失败原因；由传输层的 onTransportFailure 写入。 */
  failure?: WebRemoteControlFailure;
  /** 上次推给终端的 workspace/task 列表签名，用于去重主动推送。 */
  workspaceListPushSignature?: string;
  workspaceListPushRunning?: boolean;
  workspaceListPushPending?: boolean;
  /**
   * 终端是否已经连上过。掉线时只有它为真才走 3s 宽限（发行版的 mobileConnected），
   * 状态面在宽限期内继续报 paired，短暂重连不会让胶囊先掉到「已就绪」再跳回来。
   */
  mobileConnected: boolean;
  mobileGraceTimer?: ReturnType<typeof setTimeout>;
  /** 最近一条终端桥；rpc-frame 与传输层故障都只认它，不能按 Map 顺序猜。 */
  currentBridge?: RelayBridgeHandle;
}

export interface WebRemoteControlManager {
  enable: (
    windowId: number,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      initialTaskId?: string;
    },
  ) => Promise<WebRemoteControlStatus>;
  disable: (windowId: number, reason?: string) => void;
  getStatus: (windowId: number) => WebRemoteControlStatus;
  resetPairing: (windowId: number, reason: string) => Promise<WebRemoteControlStatus>;
  /** 窗口 workspace 集合变化时推送 `workspace-list-updated`；未配对时静默忽略。 */
  notifyWorkspacesChanged: (windowId: number) => void;
  /**
   * 启动恢复：窗口首次报上 workspace 集合时调用一次。命中上次启用的 workspacePath 就自动
   * enable，让用户重启后不必再点一次开关。每个进程只尝试一次，避免与用户手动 disable 打架。
   */
  tryRestoreOnWorkspacesReady: (windowId: number) => void;
  disposeAll: (reason?: string) => void;
}

export function createWebRemoteControlManager(
  deps: WebRemoteControlManagerDeps,
): WebRemoteControlManager {
  const sessions = new Map<number, ActiveSession>();
  // enable 在下面的 manager 里定义；这里只在运行时调用，所以闭包引用是安全的。
  const restorer = createRelayStartupRestorer({
    storage: deps.startupRestoreStorage,
    listWorkspacePaths: (windowId) => deps.listWorkspacePaths(windowId),
    hasSession: (windowId) => sessions.has(windowId),
    enable: (windowId, context) => manager.enable(windowId, context),
    logger: deps.logger,
  });
  // 「上次启用」上下文既被 enable 写、又被 disable 清，两边都是异步落盘。
  // 不排队就会出现 disable 的 clear 先落、enable 的 save 后落，用户已经关掉的
  // 远控在下次启动又被自动打开。这里按调用顺序串成一条链，保证后发的意图覆盖先发。
  let restoreWrite: Promise<unknown> = Promise.resolve();
  const queuePersistenceWrite = (op: () => Promise<unknown>): void => {
    restoreWrite = restoreWrite.then(op, op);
  };

  const publish = (session: ActiveSession | undefined): void => {
    if (!session) return;
    deps.onStatusChanged?.(
      session.windowId,
      buildRelayStatus(session, deps.listWorkspacePaths(session.windowId).length),
    );
  };

  const buildPairingUrl = createRelayPairingUrlBuilder({
    deviceMid: deps.deviceMid,
    deviceName: deps.deviceName,
    appVersion: deps.appVersion,
  });

  /** 控制面 attachment：只用于列举 workspace/task，不转发终端流量。 */
  const openControlAttachment = (session: ActiveSession): IServiceAccessor | undefined => {
    if (session.controlAccessor) return session.controlAccessor;
    const host = deps.getHostProcess(session.windowId);
    if (!host) return undefined;
    const attachment = attachLocalHostServicePort({
      host,
      createMessageChannel: deps.createMessageChannel,
    });
    const accessor = connectViaMessagePort(attachment.port);
    session.controlAttachment = attachment;
    session.controlAccessor = accessor;
    return accessor;
  };

  const controlDeps = (session: ActiveSession): RelayControlPlaneDeps => ({
    getDeviceSid: () => session.transport.getDeviceSid(),
    listWorkspacePaths: () => deps.listWorkspacePaths(session.windowId),
    getAccessor: () => openControlAttachment(session),
    sendPayload: (payload) => session.transport.sendPayload(payload),
    logger: deps.logger,
    getAppVersion: () => deps.appVersion,
    getInitialTaskId: () => session.initialTaskId,
    getMobileViewState: () => session.mobileViewState,
    getBridgeInitialTaskId: () => session.currentBridge?.initialTaskId,
    getRuntimeTarget: () =>
      resolveRelayRuntimeTarget(
        [...session.bridges.values()].map((bridge) => bridge.target),
        deps.listWorkspacePaths(session.windowId),
      ),
  });

  /**
   * workspaceKey → 桌面目标。走控制面同一份 workspace 列表，不再各自按路径比对：
   * 列表说没有就等于终端请求了一个本窗口没有的工作区，建桥与重连必须给出同一个答案。
   */
  const resolveWorkspaceTarget = (
    session: ActiveSession,
    workspaceKey: string,
  ): RelayWorkspaceTarget | undefined =>
    findRelayWorkspaceTarget(listRelayWorkspaces(controlDeps(session)), workspaceKey);

  /** 终端桥：装配细节在 relayBridgeSession，这里只负责去重与登记。 */
  const openBridge = (session: ActiveSession, payload: Record<string, unknown>): void => {
    const bridgeSessionId = String(payload.bridgeSessionId ?? "");
    if (!bridgeSessionId || session.bridges.has(bridgeSessionId)) return;
    const handle = openRelayBridge(
      {
        windowId: session.windowId,
        getHostProcess: deps.getHostProcess,
        createMessageChannel: deps.createMessageChannel,
        resolveTarget: (workspaceKey) => resolveWorkspaceTarget(session, workspaceKey),
        sendPayload: (frame) => session.transport.sendPayload(frame),
        getDeviceSid: () => session.transport.getDeviceSid(),
        logger: deps.logger,
      },
      payload,
      bridgeSessionId,
    );
    if (!handle) return;
    session.bridges.set(bridgeSessionId, handle);
    session.currentBridge = handle;
  };

  /** 每个会话一条控制面路由：闭包捕获 session，分派表本身放在 relayPayloadRouter。 */
  const createPayloadRouter = (session: ActiveSession): RelayPayloadRouter =>
    createRelayPayloadRouter({
      // 只有当前桥收 rpc-frame：旧桥的迟到帧如果照单全收，会把已结束的一轮 RPC 混进新会话。
      getBridge: (bridgeSessionId) =>
        session.currentBridge?.bridgeSessionId === bridgeSessionId
          ? session.bridges.get(bridgeSessionId)
          : undefined,
      sendPayload: (payload) => {
        session.transport.sendPayload(payload);
      },
      controlPlane: () => controlDeps(session),
      openBridge: (payload) => openBridge(session, payload),
      resolveTarget: (workspaceKey) => resolveWorkspaceTarget(session, workspaceKey),
      platformHandlers: deps.platformHandlers,
      applyMobileViewState: (viewState, deviceInfo) => {
        // 设备类型变了要立刻推状态，否则胶囊会一直停在上一台的「手机」上。
        if (applyRelayTerminalState(session, viewState, deviceInfo)) publish(session);
      },
      logger: deps.logger,
      getDeviceSid: () => session.transport.getDeviceSid(),
    });

  const startSession = async (windowId: number, initialTaskId?: string): Promise<ActiveSession> => {
    const { passHash: storedPassHash, deviceSid: storedDeviceSid } =
      await loadPairedRelayCredential({
        windowId,
        readPassHash: deps.readPassHash,
        readDeviceSid: deps.readDeviceSid,
        clearPassHash: deps.clearPassHash,
        clearDeviceSid: deps.clearDeviceSid,
        logger: deps.logger,
      });
    const endpoints = await deps.resolveRelayEndpoints();
    const session: Omit<ActiveSession, "transport"> & { transport?: ActiveSession["transport"] } = {
      windowId,
      credentials:
        storedPassHash && storedDeviceSid
          ? { password: "", passHash: storedPassHash }
          : createExternalRelayCredentials(),
      bridges: new Map(),
      state: "connecting",
      mobileConnected: false,
      endpoints,
      ...(initialTaskId ? { initialTaskId } : {}),
    };
    // 凭据必须是会话级可变状态：relay 拒绝持久化 sid 后 transport 会要求清凭据并重新注册，
    // 如果 resolveAuth 仍返回启动时快照的 persisted 组合，就会拿同一个死 sid 无限重连。
    let persistedDeviceSid = storedPassHash && storedDeviceSid ? storedDeviceSid : undefined;
    // 路由闭包只在收到帧时才读 session.transport，因此可以先于 transport 建立。
    const router = createPayloadRouter(session as ActiveSession);

    // transport 的回调里要引用 session，因此先声明再赋值，避免对象字面量自引用。
    let transport!: ActiveSession["transport"];
    transport = createRelayDeviceTransport({
      relayWsUrl: endpoints.relayWsUrl,
      deviceMid: deps.deviceMid,
      meta: buildRelayMeta({
        appVersion: deps.appVersion,
        platform: deps.platform,
        deviceName: deps.deviceName,
      }),
      createSocket: deps.createSocket,
      resolveAuth: () =>
        persistedDeviceSid
          ? {
              mode: "persisted",
              deviceSid: persistedDeviceSid,
              passHash: session.credentials.passHash,
            }
          : { mode: "register", passHash: session.credentials.passHash },
      onRegisteredAuth: (auth) => {
        // 先同步更新会话凭据，再落盘：transport 紧接着可能重连并回调 resolveAuth。
        session.credentials = { password: "", passHash: auth.passHash };
        persistedDeviceSid = auth.deviceSid;
        session.pairingUrl = buildPairingUrl(session, auth.deviceSid);
        session.pairingUrlSid = auth.deviceSid;
        queuePersistenceWrite(async () => {
          await deps.savePassHash(auth.passHash);
          await deps.saveDeviceSid(auth.deviceSid);
          deps.logger.info("[web-remote-control] external relay auth saved", {
            windowId,
            ...describeExternalRelayAuthForLog(auth),
          });
          publish(session as ActiveSession);
        });
      },
      // 中继拒收持久化凭据：口令本身没问题，问题在 sid 已经不被认。
      // 所以只丢 sid、沿用同一 passHash 重新注册——发行版正是这样，
      // 用户已经扫过/复制过的二维码里的 `hash` 因此继续有效。
      onClearAuth: (reason) => {
        persistedDeviceSid = undefined;
        session.pairingUrl = undefined;
        session.pairingUrlSid = undefined;
        session.deviceInfo = undefined;
        queuePersistenceWrite(async () => {
          await deps.clearDeviceSid();
          deps.logger.info("[web-remote-control] external relay device_sid cleared", {
            windowId,
            reason,
          });
          publish(session as ActiveSession);
        });
      },
      onData: (payload) => router(payload),
      // 物理帧超限一类的传输故障要转成桥的降级通告，否则终端只会表现为偶发丢帧且不自愈。
      onTransportFault: (reason) => session.currentBridge?.degrade(reason),
      // 终局失败要带上原因落进状态面：否则用户只看到一个没有解释的 error。
      onTransportFailure: (failure) => {
        session.failure = failure;
        publish(session as ActiveSession);
      },
      onStateChange: (state) => {
        session.state = state;
        if (state === "paired") {
          clearRelayMobileGrace(session);
          session.mobileConnected = true;
        } else if (state === "error" || state === "idle") {
          // 终局失败或已停止：宽限没有意义，立刻落回真实状态。
          clearRelayMobileGrace(session);
          session.mobileConnected = false;
          session.deviceInfo = undefined;
        } else if (
          // 设备信息描述的是「此刻占着配对槽位的那台终端」。宽限到期后必须一起清掉，
          // 否则胶囊会一直挂着上一台的平台名（Win32），而不是回到「已就绪」。
          !holdRelayMobileGrace(session, () => {
            session.deviceInfo = undefined;
            publish(session as ActiveSession);
          })
        ) {
          session.deviceInfo = undefined;
        }
        const sid = session.transport?.getDeviceSid();
        // 配对链接在拿到 deviceSid 之后才成立；持久化鉴权模式下不会有
        // device_register_ack，因此这里统一补建。判据是 sid 而不是「有没有链接」：
        // 中继换发新 sid 后，只按「已存在」跳过就会把旧 sid 的死链接一直挂在二维码上。
        if (sid && session.pairingUrlSid !== sid && state !== "idle" && state !== "connecting") {
          session.pairingUrl = buildPairingUrl(session, sid);
          session.pairingUrlSid = sid;
        }
        if (state === "waiting_terminal" && !session.pairingUrl) session.state = "pairing";
        publish(session as ActiveSession);
      },
      logger: deps.logger,
    });
    session.transport = transport;
    transport.start();
    return session as ActiveSession;
  };

  const manager: WebRemoteControlManager = {
    enable: async (windowId, context) => {
      const existing = sessions.get(windowId);
      if (existing) return buildRelayStatus(existing);
      const session = await startSession(windowId, context?.initialTaskId);
      sessions.set(windowId, session);
      queuePersistenceWrite(() =>
        saveStartupRestoreContext({
          context: context?.workspacePath
            ? {
                workspacePath: context.workspacePath,
                ...(context.workspaceIdentity
                  ? { workspaceIdentity: context.workspaceIdentity }
                  : {}),
                ...(context.initialTaskId ? { initialTaskId: context.initialTaskId } : {}),
              }
            : undefined,
          storage: deps.startupRestoreStorage,
        }),
      );
      return buildRelayStatus(session);
    },
    disable: (windowId, reason) => {
      const session = sessions.get(windowId);
      if (!session) return;
      disposeRelaySession(session, reason ?? "user-disabled");
      sessions.delete(windowId);
      // 关窗导致的 disable 不算用户意图变更，保留上下文，下次启动仍然自动恢复。
      if (reason !== "window-closed") {
        queuePersistenceWrite(async () => deps.startupRestoreStorage?.clear());
      }
      // 不置一次性恢复标志：发行版的 stop 也不碰它。在这里置位会让「某个窗口关窗或停止」
      // 连带禁掉本进程其它窗口的启动恢复。
      deps.onStatusChanged?.(windowId, buildRelayStatus(undefined));
    },
    getStatus: (windowId) => buildRelayStatus(sessions.get(windowId)),
    notifyWorkspacesChanged: (windowId) => {
      const session = sessions.get(windowId);
      if (!session) return;
      // 期间掉线就不推了：终端重连后会自己重新 bootstrap，补推只会是过期快照。
      // tab 同步很频繁，列表内容没变也不推，避免终端反复重建投影。
      requestRelayWorkspaceListPush(session, {
        build: () => buildRelayWorkspaceListResult(controlDeps(session)),
        signatureOf: buildRelayWorkspaceListPushSignature,
        isPaired: () => session.state === "paired",
        send: (result) =>
          session.transport.sendPayload({ zcode_type: "workspace-list-updated", result }),
        onFailure: (error: unknown) =>
          deps.logger.warn("[web-remote-control] workspace-list-updated 组装失败", {
            windowId,
            message: error instanceof Error ? error.message : String(error),
          }),
      });
    },
    tryRestoreOnWorkspacesReady: (windowId) => restorer.tryRestore(windowId),
    resetPairing: async (windowId, reason) => {
      // 二维码含 pass_hash，泄漏等价于配对凭据泄漏：清凭据后重新注册。
      const current = sessions.get(windowId);
      if (current) {
        sessions.delete(windowId);
        disposeRelaySession(current, `reset:${reason}`);
      }
      await deps.clearPassHash(reason);
      await deps.clearDeviceSid();
      const session = await startSession(windowId);
      sessions.set(windowId, session);
      return buildRelayStatus(session);
    },
    disposeAll: (reason) => {
      for (const session of sessions.values()) {
        disposeRelaySession(session, reason ?? "app-shutdown");
      }
      sessions.clear();
    },
  };

  return manager;
}
