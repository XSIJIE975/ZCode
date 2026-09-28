import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";

// 移动端远控的控制面：把 Host 的真实 workspace/task 组织成终端 zod 认可的载荷。
// 字段集合严格对齐 docs/specs/web-remote-control-relay.md §8.1；多发或漏发字段都会被
// 终端静默丢弃（表现为 desktop-bootstrap-timeout），因此这里不做任何"顺手带上"的扩展。

export const RELAY_TASK_DISPLAY_STATUSES = ["idle", "running", "completed", "error"] as const;
export type RelayTaskDisplayStatus = (typeof RELAY_TASK_DISPLAY_STATUSES)[number];

/** 终端 workspace 条目。`remoteSessionId` 只属于远程 workspace，本地缺省。 */
export interface RelayWorkspaceDescriptor {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  label: string;
  workspacePurpose?: "project" | "conversation";
  kind: "local" | "remote";
  connectionState?: "connected" | "disconnected" | "reconnecting";
  lastConnectionError?: string;
}

/** 终端 task 条目。 */
export interface RelayTaskDescriptor {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspaceLabel: string;
  workspaceKind: "local" | "remote";
  createdAt: number;
  updatedAt: number;
  provider?: string;
  unreadAt?: number;
  displayStatus?: RelayTaskDisplayStatus;
  pinned?: boolean;
  archived?: boolean;
}

export interface RelayViewState {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
}

/** 会话当前面向的主目标：有桥时是桥所在 workspace，否则是窗口的第一个 workspace。 */
export interface RelayWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  kind: "local" | "remote";
}

export interface RelayBootstrapResult {
  windowControlSessionId: string;
  desktopAppVersion: string;
  workspaces: RelayWorkspaceDescriptor[];
  tasks: RelayTaskDescriptor[];
  initialViewState?: RelayViewState;
  mobileViewState?: RelayViewState;
}

export interface RelayWorkspaceListResult {
  workspaces: RelayWorkspaceDescriptor[];
  tasks?: RelayTaskDescriptor[];
  activeWorkspaceKey?: string;
  activeTaskId?: string;
}

export function relayWorkspaceKeyOf(workspace: RelayWorkspaceDescriptor): string {
  // 与仓库 Workspace Identity 规则一致：identity 优先，回退本地路径。
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
}

export function relayWorkspaceLabelFromPath(workspacePath: string): string {
  const segments = workspacePath.split(/[\\/]+/u).filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

function toDisplayStatus(meta: ZCodeTaskMeta): RelayTaskDisplayStatus {
  const status = (meta as { status?: unknown }).status;
  return typeof status === "string" &&
    (RELAY_TASK_DISPLAY_STATUSES as readonly string[]).includes(status)
    ? (status as RelayTaskDisplayStatus)
    : "idle";
}

export function toRelayTaskDescriptor(
  meta: ZCodeTaskMeta,
  workspace: RelayWorkspaceDescriptor,
): RelayTaskDescriptor {
  const descriptor: RelayTaskDescriptor = {
    taskId: meta.taskId,
    title: typeof meta.title === "string" ? meta.title : "",
    workspacePath: meta.workspacePath || workspace.workspacePath,
    workspaceLabel: workspace.label,
    workspaceKind: workspace.kind,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    displayStatus: toDisplayStatus(meta),
  };
  if (meta.workspaceIdentity) descriptor.workspaceIdentity = meta.workspaceIdentity;
  const remoteSessionId = (meta as { remoteSessionId?: unknown }).remoteSessionId;
  if (typeof remoteSessionId === "string" && remoteSessionId)
    descriptor.remoteSessionId = remoteSessionId;
  if (typeof meta.provider === "string" && meta.provider) descriptor.provider = meta.provider;
  const unreadAt = (meta as { unreadAt?: unknown }).unreadAt;
  if (typeof unreadAt === "number") descriptor.unreadAt = unreadAt;
  const pinned = (meta as { pinned?: unknown }).pinned;
  if (typeof pinned === "boolean") descriptor.pinned = pinned;
  const archived = (meta as { archived?: unknown }).archived;
  if (typeof archived === "boolean") descriptor.archived = archived;
  return descriptor;
}

export interface RelayControlPlaneDeps {
  getDeviceSid: () => string | undefined;
  /** 该窗口当前打开的 workspace 路径；由 main 的窗口 workspace 注册表提供。 */
  listWorkspacePaths: () => string[];
  /** Host 服务面；attachment 建立前可能为空，此时按空列表回复而不是报错。 */
  getAccessor: () => IServiceAccessor | undefined;
  sendPayload: (payload: unknown) => void;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
  getAppVersion: () => string;
  /** 会话启用时带入的 task，决定 `initialViewState` 是否存在。 */
  getInitialTaskId: () => string | undefined;
  /** 终端上次上报的自身视图，优先级高于桌面推断。 */
  getMobileViewState: () => RelayViewState | undefined;
  /** 当前桥的 initialTaskId；无桥时 undefined。 */
  getBridgeInitialTaskId: () => string | undefined;
  /** 会话的主 workspace 目标。 */
  getRuntimeTarget: () => RelayWorkspaceTarget | undefined;
}

/**
 * 远端目标必须同时带 identity 与 remoteSessionId 才可桥接，否则终端无法按身份恢复。
 * 本地目标恒可桥接。
 *
 * 判据用 trim 后的非空：终端这两个字段都是 `Z = string().trim().min(1)`，只有空白串的
 * 目标既建不出合形的描述符，也不该被当成可桥接——两处必须同一口径，否则会出现
 * 「initialViewState 说可桥接、建桥却失败」的分歧。
 */
export function isBridgeableRelayTarget(target: RelayWorkspaceTarget): boolean {
  return (
    target.kind !== "remote" ||
    Boolean(target.workspaceIdentity?.trim() && target.remoteSessionId?.trim())
  );
}

export function relayTargetKeyOf(target: RelayWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

/**
 * 桌面侧「初始视图」：只有会话带着 initialTaskId 启动、且主目标可桥接时才成立。
 * 不能拿任务列表的第一条顶替——那是"最近的任务"而不是"桌面正在看的那个"，
 * 会让终端首屏跳到用户没在看的会话。
 */
export function buildRuntimeInitialViewState(
  deps: RelayControlPlaneDeps,
): RelayViewState | undefined {
  const initialTaskId = deps.getInitialTaskId();
  const target = deps.getRuntimeTarget();
  if (!initialTaskId || !target || !isBridgeableRelayTarget(target)) return undefined;
  return {
    activeWorkspaceKey: relayTargetKeyOf(target),
    activeTaskId: initialTaskId,
    updatedAt: Date.now(),
  };
}

/**
 * 本窗口暴露给终端的 workspace 列表的唯一构造点。
 *
 * 目前只有本地路径：main 侧的窗口 workspace 注册表（`windowWorkspaceMap`）按契约就只收本地
 * 路径，renderer 在 `syncWindowTabs` 之前会把远程 tab 整条滤掉。远程 workspace 的事实源是
 * `desktopRemoteSessions` 的连接注册表，但它没有对外列举入口，因此这里不伪造 remote 条目。
 * 补齐列举入口后，remote 描述符只应在这一处并入，`collectRelayWorkspacesAndTasks`、建桥与
 * 重连判定都自动跟着走，不再需要各自的按路径匹配。
 */
export function listRelayWorkspaces(
  deps: Pick<RelayControlPlaneDeps, "listWorkspacePaths">,
): RelayWorkspaceDescriptor[] {
  return deps.listWorkspacePaths().map((workspacePath) => ({
    workspacePath,
    workspaceIdentity: workspacePath,
    label: relayWorkspaceLabelFromPath(workspacePath),
    workspacePurpose: "project",
    kind: "local",
    connectionState: "connected",
  }));
}

/**
 * 按终端回传的 `workspaceKey` 解析目标。
 *
 * 终端不带 `workspaceIdentity`/`remoteSessionId` 上来（`workspace-bridge-open` 的 schema 里
 * 只有 `workspaceKey` 与 `taskId`），所以这两个字段必须由桌面侧的列表反查；键规则与
 * `relayWorkspaceKeyOf` 同一条，不能退化成按 `workspacePath` 匹配——远程身份的 key 是
 * identity，与路径不是同一个值。
 */
export function findRelayWorkspaceTarget(
  workspaces: readonly RelayWorkspaceDescriptor[],
  workspaceKey: string,
): RelayWorkspaceTarget | undefined {
  const wanted = workspaceKey.trim();
  if (!wanted) return undefined;
  const found = workspaces.find((workspace) => relayWorkspaceKeyOf(workspace) === wanted);
  if (!found) return undefined;
  return {
    workspacePath: found.workspacePath,
    kind: found.kind,
    ...(found.workspaceIdentity ? { workspaceIdentity: found.workspaceIdentity } : {}),
    ...(found.remoteSessionId ? { remoteSessionId: found.remoteSessionId } : {}),
  };
}

/**
 * 组装 workspaces + tasks。
 * 任务事实源是 Host 的 `IZCodeTaskService.listTasks`（真相源 tasks-index.sqlite），
 * main 不缓存任何 task 状态，避免产生第二份所有者。
 */
export async function collectRelayWorkspacesAndTasks(
  deps: RelayControlPlaneDeps,
): Promise<{ workspaces: RelayWorkspaceDescriptor[]; tasks: RelayTaskDescriptor[] }> {
  const workspaces = listRelayWorkspaces(deps);

  const accessor = deps.getAccessor();
  if (!accessor) {
    return { workspaces, tasks: [] };
  }

  const tasks: RelayTaskDescriptor[] = [];
  for (const workspace of workspaces) {
    try {
      const metas = await accessor.zcodeTaskService.listTasks({
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
      });
      for (const meta of metas ?? []) {
        tasks.push(toRelayTaskDescriptor(meta, workspace));
      }
    } catch (error) {
      // 单个 workspace 读取失败不应让整份列表消失；终端只要求 workspaces 非空字段合形。
      deps.logger.warn("relay listTasks failed for workspace", {
        workspacePath: workspace.workspacePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // 与桌面列表一致：更新时间倒序，同值再按创建时间、taskId 定序，保证签名稳定不抖。
  tasks.sort((left, right) =>
    right.updatedAt !== left.updatedAt
      ? right.updatedAt - left.updatedAt
      : right.createdAt !== left.createdAt
        ? right.createdAt - left.createdAt
        : left.taskId.localeCompare(right.taskId),
  );
  return { workspaces, tasks };
}

export async function buildRelayBootstrapResult(
  deps: RelayControlPlaneDeps,
): Promise<RelayBootstrapResult | undefined> {
  // 终端 schema 是 `windowControlSessionId: string().trim().min(1)`：拿不到 sid 时
  // 补一个空串会让整条 bootstrap-response 判不合形被**静默丢弃**，终端只会在超时后
  // 报误导性的 desktop-bootstrap-timeout。此时返回 undefined，由路由层回 success:false。
  const deviceSid = deps.getDeviceSid()?.trim();
  if (!deviceSid) return undefined;
  const { workspaces, tasks } = await collectRelayWorkspacesAndTasks(deps);
  const initialViewState = buildRuntimeInitialViewState(deps);
  const mobileViewState = deps.getMobileViewState();
  return {
    windowControlSessionId: deviceSid,
    desktopAppVersion: deps.getAppVersion(),
    workspaces,
    tasks,
    ...(initialViewState ? { initialViewState } : {}),
    ...(mobileViewState ? { mobileViewState } : {}),
  };
}

export async function buildRelayWorkspaceListResult(
  deps: RelayControlPlaneDeps,
): Promise<RelayWorkspaceListResult> {
  const { workspaces, tasks } = await collectRelayWorkspacesAndTasks(deps);
  const mobile = deps.getMobileViewState();
  const runtime = buildRuntimeInitialViewState(deps);
  const target = deps.getRuntimeTarget();
  // 优先级与发行版一致：终端自己看过的位置 > 桥的初始 task > 桌面推断的初始视图 > 主 workspace。
  const activeWorkspaceKey =
    mobile?.activeWorkspaceKey ??
    runtime?.activeWorkspaceKey ??
    (target ? relayTargetKeyOf(target) : undefined);
  const activeTaskId =
    mobile?.activeTaskId ?? deps.getBridgeInitialTaskId() ?? runtime?.activeTaskId;
  return {
    workspaces,
    tasks,
    ...(activeWorkspaceKey ? { activeWorkspaceKey } : {}),
    ...(activeTaskId ? { activeTaskId } : {}),
  };
}

/**
 * 推送去重签名：只取会影响终端列表呈现的字段，并按稳定顺序拼接。
 * 未命中变化就不发 `workspace-list-updated`，避免每次 tab 同步都把整份快照推一遍。
 */
export function buildRelayWorkspaceListPushSignature(result: RelayWorkspaceListResult): string {
  const workspaceKeys = (result.workspaces ?? [])
    .map((workspace) =>
      JSON.stringify([
        relayWorkspaceKeyOf(workspace),
        workspace.kind,
        workspace.connectionState ?? "connected",
        workspace.remoteSessionId ?? "",
        workspace.lastConnectionError ?? "",
      ]),
    )
    .sort();
  const taskKeys = (result.tasks ?? [])
    .map((task) =>
      JSON.stringify([
        task.workspaceIdentity?.trim() || task.workspacePath,
        task.taskId,
        task.title,
        task.remoteSessionId ?? "",
        task.displayStatus ?? "idle",
        // 发行版此处还参与 hasBackgroundWork / workflowActivity 两个字段：它们属于会话快照，
        // 不在 §8.1 的 wire task 里，本端不发送，因此也不纳入去重签名。
        typeof task.unreadAt === "number" ? task.unreadAt : "",
        Boolean(task.pinned),
        Boolean(task.archived),
      ]),
    )
    .sort();
  return JSON.stringify([workspaceKeys, taskKeys]);
}
