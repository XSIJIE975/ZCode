import { useEffect, useState } from "react";
import type { ZCodeTaskTokenUsageResult } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

/**
 * 会话统计条的持久化数据源：v4/conversation/usage → SQLite model_usage/turn_usage
 * 聚合。与进程内 session-debug 快照不同，应用重启后历史会话仍有数据
 * （usage 表保留 30 天）。refreshKey 变化（新完成请求计数）时延迟重取，
 * 让用量事实先落库；冷启动与切换会话各取一次。
 */
export function useTaskUsageStats({
  workspacePath,
  workspaceIdentity,
  taskId,
  refreshKey,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  refreshKey: number | undefined;
}) {
  const { zcodeAgentService } = useServices();
  const scopeKey = JSON.stringify([workspaceIdentity?.trim() || workspacePath, taskId]);
  const [result, setResult] = useState<{
    key: string;
    service: typeof zcodeAgentService;
    data: ZCodeTaskTokenUsageResult | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let disposed = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const data = await zcodeAgentService.getTaskTokenUsage({
            workspacePath,
            workspaceIdentity,
            sessionId: taskId,
          });
          if (!disposed) {
            setResult({ key: scopeKey, service: zcodeAgentService, data, error: false });
          }
        } catch {
          if (!disposed) {
            setResult((previous) =>
              previous?.key === scopeKey && previous.service === zcodeAgentService
                ? { ...previous, error: true }
                : { key: scopeKey, service: zcodeAgentService, data: null, error: true },
            );
          }
        }
      })();
    }, 400);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [scopeKey, taskId, refreshKey, workspaceIdentity, workspacePath, zcodeAgentService]);

  const current =
    result?.key === scopeKey && result.service === zcodeAgentService ? result : null;
  return { usage: current?.data ?? null, error: current?.error ?? false };
}
