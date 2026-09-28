import type {
  WebRemoteControlDeviceInfo,
  WebRemoteControlFailure,
  WebRemoteControlState,
  WebRemoteControlStatus,
} from "@zcode/shared";
import {
  relayTargetKeyOf,
  type RelayViewState,
  type RelayWorkspaceTarget,
} from "./relayControlPlane.js";
import type { ExternalRelayMeta } from "./relayProtocol.js";

// relayManager 的装配辅助：都是「拿入参算出线上载荷 / 落一次盘」的纯步骤，
// 不持有会话状态，单独成文件让 relayManager 只剩装配与路由。

/** 上次启用远控时的 workspace 上下文；字段与发行版 startupRestoreStorageProvider 一致。 */
export interface RelayStartupRestoreContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export interface RelayStartupRestoreStorage {
  load: () => Promise<RelayStartupRestoreContext | undefined>;
  save: (context: RelayStartupRestoreContext) => Promise<void>;
  clear: () => Promise<void>;
}

export function buildRelayMeta(input: {
  appVersion: string;
  platform: NodeJS.Platform;
  deviceName: string;
}): ExternalRelayMeta {
  return { platform: input.platform, version: input.appVersion, name: input.deviceName };
}

/**
 * 配对二维码 URL。终端只在参数非空白时才读取 mid/name/app_version，
 * 空值要以「不出现」而不是「空串」的形式上线，否则终端会把空串当成有效设备名展示。
 */
export function buildRelayPairingUrl(input: {
  remoteUrl: string;
  deviceSid: string;
  passHash: string;
  timestamp: number;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
}): string {
  const url = new URL(input.remoteUrl);
  url.searchParams.set("sid", input.deviceSid);
  url.searchParams.set("hash", input.passHash);
  url.searchParams.set("t", String(input.timestamp));
  const optional: Array<[string, string | undefined]> = [
    ["mid", input.deviceMid],
    ["name", input.deviceName],
    ["app_version", input.appVersion],
  ];
  for (const [key, value] of optional) {
    if (value?.trim()) url.searchParams.set(key, value);
  }
  return url.toString();
}

export type RelayPairingUrlBuilder = (
  input: { credentials: { passHash: string }; endpoints: { remoteUrl: string } },
  deviceSid: string,
) => string;

/**
 * 配对链接按「passHash + deviceSid」缓存：同一份凭据在同一次启用里只对应一个链接，
 * 所以「停止→再进来」二维码不变，不会每次 enable 都用时间戳重算出另一张码；
 * 但 sid 一旦换发（中继不认旧 sid、重新注册）就必须产出新链接，
 * 只按 passHash 缓存会把带旧 sid 的死链接继续摆在二维码上。
 */
export function createRelayPairingUrlBuilder(deps: {
  deviceMid: string;
  deviceName: string;
  appVersion: string;
}): RelayPairingUrlBuilder {
  const cache = new Map<string, string>();
  return (input, deviceSid) => {
    const key = `${input.credentials.passHash}|${deviceSid}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const url = buildRelayPairingUrl({
      remoteUrl: input.endpoints.remoteUrl,
      deviceSid,
      passHash: input.credentials.passHash,
      timestamp: Date.now(),
      deviceMid: deps.deviceMid,
      deviceName: deps.deviceName,
      appVersion: deps.appVersion,
    });
    cache.set(key, url);
    return url;
  };
}

/** 会话主目标：有桥时是桥所在 workspace，否则退回窗口第一个 workspace。 */ export function resolveRelayRuntimeTarget(
  bridges: readonly RelayWorkspaceTarget[],
  workspacePaths: readonly string[],
): RelayWorkspaceTarget | undefined {
  const bridgeTarget = bridges.at(-1);
  if (bridgeTarget) return bridgeTarget;
  const [firstPath] = workspacePaths;
  return firstPath
    ? { workspacePath: firstPath, workspaceIdentity: firstPath, kind: "local" }
    : undefined;
}

/**
 * 终端上报的视图状态是远端输入，逐字段校验后才可信；不合形按没收到处理，
 * 不能让一个畸形 viewState 把后续 bootstrap 的 activeWorkspaceKey 带偏。
 */
export function parseRelayViewState(raw: unknown): RelayViewState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const input = raw as Record<string, unknown>;
  if (typeof input.updatedAt !== "number" || !Number.isFinite(input.updatedAt)) return undefined;
  const activeWorkspaceKey =
    typeof input.activeWorkspaceKey === "string" && input.activeWorkspaceKey.trim()
      ? input.activeWorkspaceKey
      : undefined;
  const activeTaskId =
    typeof input.activeTaskId === "string" && input.activeTaskId.trim()
      ? input.activeTaskId
      : undefined;
  return {
    updatedAt: input.updatedAt,
    ...(activeWorkspaceKey ? { activeWorkspaceKey } : {}),
    ...(activeTaskId ? { activeTaskId } : {}),
  };
}

/**
 * 终端 `workspace-bridge-error` 的 reason 联合（终端 sg 的子集），只列设备端建桥会产生的四种，
 * 由映射函数产出，避免把任意字符串塞进终端枚举导致整帧被判不合形丢弃。
 */
const RELAY_BRIDGE_FAILURE_REASONS = [
  "desktop-disconnected",
  "workspace-closed",
  "unsupported-action",
  "unexpected-error",
] as const;

export type RelayBridgeFailureReason = (typeof RELAY_BRIDGE_FAILURE_REASONS)[number];

/** 建桥失败的错误码；与 main 侧 Host attachment 入口抛出的码字面一致。 */
const RELAY_BRIDGE_FAILURE_CODES: Record<string, RelayBridgeFailureReason> = {
  DESKTOP_HOST_MISSING: "desktop-disconnected",
  // 远程 session 已经不在了：对终端来说这就是"那个 workspace 关闭了"。
  REMOTE_SESSION_MISSING: "workspace-closed",
  REMOTE_SESSION_WINDOW_MISMATCH: "workspace-closed",
  // 身份缺失/不匹配时无法构造可恢复的远程作用域，终端只能按不支持处理。
  REMOTE_WORKSPACE_IDENTITY_MISSING: "unsupported-action",
  REMOTE_WORKSPACE_IDENTITY_MISMATCH: "unsupported-action",
};

/**
 * 建桥失败原因映射：读错误上的 `code`，命中已知码回对应 reason，其余回 `unexpected-error`。
 *
 * 之前建桥失败路径只写死 `desktop-disconnected`，远程 session 缺失、身份不匹配和真正的
 * 内部异常在手机上全都显示成同一句"桌面已断开"，用户不知道该重连还是该重开工作区。
 */
export function mapRelayBridgeFailureReason(error: unknown): RelayBridgeFailureReason {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  return (code && RELAY_BRIDGE_FAILURE_CODES[code]) || "unexpected-error";
}

/** 终端 `workspace-bridge-error` / `bridge` 里可选 id 的形态：非空白字符串才允许上线。 */
function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 终端 `workspace-bridge-ready` 里 `bridge` 的线上形状（判别式两变体的并集视图）。 */
export interface RelayBridgeDescriptor {
  bridgeSessionId: string;
  kind: "local" | "remote";
  /** 身份键：`workspaceIdentity?.trim() || workspacePath`，远程身份下不等于路径。 */
  workspaceKey: string;
  workspacePath: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  initialTaskId?: string;
  /** 仅 remote 变体出现；local 变体不带这两个键。 */
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * `workspace-bridge-ready` 里的 bridge 描述符。终端 schema（发行版记为 `cg`）是 `kind` 判别式：
 * local 变体 = `{bridgeSessionId, bridgeGeneration?, recoveryId?, workspaceKey, workspacePath,
 * initialTaskId?}`；remote 变体额外要求 `workspaceIdentity` 与 `remoteSessionId` 两个必填字符串。
 *
 * `workspaceKey` / `workspacePath` 一律取桌面解析出的目标，不回显终端传来的原值：终端的 key 是
 * 身份键，远程身份下它等于 `workspaceIdentity` 而不是路径。
 * 远程目标缺任一个必填字段时**抛错**而不是退化成 local——那会让手机把远程会话当成本地作用域，
 * 错误由建桥失败路径按 reason 回报终端。
 * 其余字段终端是 `Z = string().trim().min(1)`，缺值要以「不出现」而不是「空串」上线，
 * 否则整帧被判不合形静默丢弃；多余字段终端的对象 schema 不 strict，会被剥离，无害。
 */
export function buildBridgeDescriptor(
  payload: Record<string, unknown>,
  target: RelayWorkspaceTarget,
  bridgeSessionId: string,
): RelayBridgeDescriptor {
  const workspaceIdentity = nonBlankString(target.workspaceIdentity);
  const remoteSessionId = nonBlankString(target.remoteSessionId);
  if (target.kind === "remote" && (!workspaceIdentity || !remoteSessionId)) {
    throw Object.assign(
      new Error("远程 workspace bridge 缺少 workspaceIdentity 或 remoteSessionId。"),
      {
        code: "REMOTE_WORKSPACE_IDENTITY_MISSING",
      },
    );
  }
  const recoveryId = nonBlankString(payload.recoveryId);
  const initialTaskId = nonBlankString(payload.taskId);
  return {
    bridgeSessionId,
    kind: target.kind,
    workspaceKey: relayTargetKeyOf(target),
    workspacePath: target.workspacePath,
    ...(typeof payload.bridgeGeneration === "number"
      ? { bridgeGeneration: payload.bridgeGeneration }
      : {}),
    ...(recoveryId ? { recoveryId } : {}),
    ...(initialTaskId ? { initialTaskId } : {}),
    ...(target.kind === "remote" ? { workspaceIdentity, remoteSessionId } : {}),
  };
}

/**
 * 读取持久化的外部中继凭据。`deviceSid` 与 `passHash` 必须成对：只剩一半时那半条已经
 * 没有任何对端能验证它，留着会让每次启动都重复「判为不完整 → 按新设备注册」而清不掉脏键，
 * 因此这里直接成对清空，交回上层按新设备注册。
 */
export async function loadPairedRelayCredential(input: {
  windowId: number;
  readPassHash: () => Promise<string | undefined>;
  readDeviceSid: () => Promise<string | undefined>;
  clearPassHash: (reason: string) => Promise<void>;
  clearDeviceSid: () => Promise<void>;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
}): Promise<{ passHash?: string; deviceSid?: string }> {
  const passHash = await input.readPassHash();
  const deviceSid = await input.readDeviceSid();
  if (Boolean(passHash) === Boolean(deviceSid)) return { passHash, deviceSid };
  input.logger.warn("[web-remote-control] 外部中继凭据不完整，已清理后按新设备注册", {
    windowId: input.windowId,
    hasDeviceSid: Boolean(deviceSid),
    hasPassHash: Boolean(passHash),
  });
  await input.clearPassHash("partial-credential");
  await input.clearDeviceSid();
  return {};
}

/**
 * 应用终端上报的视图状态与设备描述。
 *
 * 视图状态**无条件覆盖**（与发行版 applyMobileViewStateUpdate 一致）：只比 activeTaskId
 * 会把"用户只切了工作区"的更新整条丢掉。
 * 返回是否真的变了，调用方据此决定要不要广播状态。
 */
export function applyRelayTerminalState(
  holder: { mobileViewState?: RelayViewState; deviceInfo?: WebRemoteControlDeviceInfo },
  rawViewState: unknown,
  rawDeviceInfo: unknown,
): boolean {
  const viewState = parseRelayViewState(rawViewState);
  const deviceInfo = parseRelayDeviceInfo(rawDeviceInfo);
  let changed = false;
  if (viewState) {
    holder.mobileViewState = viewState;
    changed = true;
  }
  // 设备信息逐字段比：每次解析都是新对象，比引用会把同一份信息当成变化反复广播。
  if (
    deviceInfo &&
    (deviceInfo.browserPlatform !== holder.deviceInfo?.browserPlatform ||
      deviceInfo.name !== holder.deviceInfo?.name)
  ) {
    holder.deviceInfo = deviceInfo;
    changed = true;
  }
  return changed;
}

/**
 * 终端离开配对槽位后的宽限期，与发行版的 mobileDisconnectGrace 同值。
 * 中继重连、终端刷新都在这个窗口里完成，界面不该先掉到「已就绪」再跳回来。
 */
export const RELAY_MOBILE_DISCONNECT_GRACE_MS = 3_000;

export interface RelayMobileGraceTarget {
  mobileConnected: boolean;
  mobileGraceTimer?: ReturnType<typeof setTimeout>;
}

/** 重新配对、终局失败或会话回收时取消宽限。 */
export function clearRelayMobileGrace(session: RelayMobileGraceTarget): void {
  clearTimeout(session.mobileGraceTimer);
  session.mobileGraceTimer = undefined;
}

/**
 * 掉出配对时是否先按住界面状态。返回 false 表示从来没有终端连上过，没有可宽限的东西，
 * 调用方要立刻落回未连接状态；返回 true 时到期后由 onExpire 收尾。
 */
export function holdRelayMobileGrace(
  session: RelayMobileGraceTarget,
  onExpire: () => void,
): boolean {
  if (!session.mobileConnected) return false;
  if (session.mobileGraceTimer) return true;
  session.mobileGraceTimer = setTimeout(() => {
    session.mobileGraceTimer = undefined;
    session.mobileConnected = false;
    onExpire();
  }, RELAY_MOBILE_DISCONNECT_GRACE_MS);
  session.mobileGraceTimer.unref?.();
  return true;
}

/** 会话对外可见的最小投影面，便于把状态组装从装配逻辑里分出去。 */
export interface RelaySessionStatusSource {
  state: WebRemoteControlState;
  /** 终端是否已连上过。宽限期内为真，界面据此继续报 paired，不等传输层回到配对。 */
  mobileConnected: boolean;
  pairingUrl?: string;
  deviceInfo?: WebRemoteControlDeviceInfo;
  failure?: WebRemoteControlFailure;
  transport: { getDeviceSid: () => string | undefined };
}

/** UI 只消费这一份状态；deviceSid 只回后 6 位，避免完整 sid 进渲染层日志。 */
export function buildRelayStatus(
  session: RelaySessionStatusSource | undefined,
  workspaceCount = 0,
): WebRemoteControlStatus {
  const deviceSid = session?.transport.getDeviceSid();
  return {
    enabled: Boolean(session),
    state: session ? (session.mobileConnected ? "paired" : session.state) : "disabled",
    ...(session?.pairingUrl ? { pairingUrl: session.pairingUrl } : {}),
    ...(session?.deviceInfo ? { deviceInfo: session.deviceInfo } : {}),
    ...(session?.failure ? { failure: session.failure } : {}),
    ...(deviceSid ? { deviceSidSuffix: deviceSid.slice(-6) } : {}),
    workspaceCount,
  };
}

/**
 * 终端上报的设备描述同样是远端输入：只挑界面会读的两个字符串字段，且必须非空白，
 * 其余（userAgent、viewport、时区…）一律不入库。
 */
export function parseRelayDeviceInfo(raw: unknown): WebRemoteControlDeviceInfo | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const input = raw as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof input[key] === "string" && input[key].trim() ? input[key] : undefined;
  const name = pick("name");
  const browserPlatform = pick("browserPlatform");
  if (!name && !browserPlatform) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(browserPlatform ? { browserPlatform } : {}),
  };
}

/**
 * 会话回收的唯一顺序：先关终端桥（停止转发 rpc-frame），再释放控制面端口，最后停 transport。
 * 反过来会先断链路、留下两个还活着却没有出口的方向。
 */
export interface RelaySessionResources {
  bridges: Map<string, { dispose(): void }>;
  controlAttachment?: { dispose(): void };
  transport: { stop: (reason?: string) => void };
}

export function disposeRelaySession(session: RelaySessionResources, reason: string): void {
  for (const bridge of session.bridges.values()) bridge.dispose();
  session.bridges.clear();
  session.controlAttachment?.dispose();
  session.transport.stop(reason);
}

/**
 * 终端 `platform-request` 的应答。成功/失败都是 `platform-response`（不是协议错误），
 * 因为终端对这条帧的 zod 校验是 success 判别式，两种形态都必须逐字段合形。
 */
export async function respondPlatformRequest(options: {
  payload: Record<string, unknown>;
  sendPayload: (payload: Record<string, unknown>) => void;
  handlers?: Record<string, (args: unknown) => Promise<unknown>>;
}): Promise<void> {
  const { payload, sendPayload, handlers } = options;
  const method = typeof payload.method === "string" ? payload.method : "";
  const handler = handlers?.[method];
  if (!handler) {
    sendPayload({
      zcode_type: "platform-response",
      requestId: payload.requestId,
      method,
      success: false,
      error: `unsupported platform method: ${method || "(empty)"}`,
    });
    return;
  }
  try {
    const result = await handler(payload.args);
    sendPayload({
      zcode_type: "platform-response",
      requestId: payload.requestId,
      method,
      success: true,
      result,
    });
  } catch (error) {
    sendPayload({
      zcode_type: "platform-response",
      requestId: payload.requestId,
      method,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 记录「上次在哪个 workspace 启用了远控」，供下次启动自动恢复。 */
export async function saveStartupRestoreContext(options: {
  context: RelayStartupRestoreContext | undefined;
  storage?: RelayStartupRestoreStorage;
}): Promise<void> {
  const { context, storage } = options;
  if (!storage) return;
  try {
    if (context?.workspacePath) {
      // 三个字段都要落：initialTaskId 丢了，恢复后终端就回不到上次那个 task，
      // 设备端的 initialViewState 分支会整体失效。
      await storage.save(context);
    } else {
      await storage.clear();
    }
  } catch {
    // 恢复上下文只是便利，写失败不应影响本次会话。
  }
}

/**
 * 恢复门禁要比较的身份键，与仓库 Workspace Identity 规则一致：
 * identity 去空白后优先，否则回退本地路径。
 */
export function relayRestoreIdentityKey(context: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return context.workspaceIdentity?.trim() || context.workspacePath;
}
