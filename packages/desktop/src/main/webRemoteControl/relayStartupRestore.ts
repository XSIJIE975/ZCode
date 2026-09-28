import { relayRestoreIdentityKey, type RelayStartupRestoreStorage } from "./relayManagerSupport.js";

// 启动恢复：上次主动启用过远控的窗口，重启后自动再启用一次，省掉一次点击。
// 单独成文件是因为它的核心是一套「门禁 + 可重试」判定，与会话装配无关。

export interface RelayRestoreEnableContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export interface RelayStartupRestorerDeps {
  storage?: RelayStartupRestoreStorage;
  listWorkspacePaths: (windowId: number) => string[];
  hasSession: (windowId: number) => boolean;
  enable: (windowId: number, context: RelayRestoreEnableContext) => Promise<unknown>;
  logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createRelayStartupRestorer(deps: RelayStartupRestorerDeps) {
  // 全进程只恢复一次；但"没通过门禁"不算尝试过，否则会被窗口上报 tab 的时序永久挡掉。
  let attempted = false;

  const tryRestore = (windowId: number): void => {
    if (attempted || deps.hasSession(windowId) || !deps.storage) return;
    void (async () => {
      const saved = await deps.storage?.load();
      if (!saved?.workspacePath) {
        attempted = true;
        return;
      }
      // 门禁与发行版一致：上次那个 workspace 此刻必须还开着，否则不恢复。
      // 不满足就直接返回、不消耗 attempted——窗口的 workspace 集合每次变化都会再进来一次，
      // 于是既不会把远控开在用户没授权过的工作区上，也不会被"先报一个 tab"的时序吃掉。
      const savedKey = relayRestoreIdentityKey(saved);
      const matched = deps
        .listWorkspacePaths(windowId)
        .find((path) => path === savedKey || path === saved.workspacePath);
      if (!matched) return;
      attempted = true;
      deps.logger.info("[web-remote-control] 启动恢复上次启用的远控会话", {
        windowId,
        workspacePath: matched,
      });
      await deps.enable(windowId, {
        workspacePath: matched,
        workspaceIdentity: saved.workspaceIdentity ?? matched,
        ...(saved.initialTaskId ? { initialTaskId: saved.initialTaskId } : {}),
      });
    })().catch((error: unknown) => {
      // 启用失败回退标志，留出重试机会（发行版在 catch 里也是这么做的）。
      attempted = false;
      deps.logger.warn("[web-remote-control] 启动恢复失败", {
        windowId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return { tryRestore };
}
