import { BadgeCheck, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";
import { useTaskUsageStats } from "@/hooks/useTaskUsageStats.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isSigningAttentionKind, signingKindLabelId } from "@/lib/clientSigningLabels.js";

/**
 * 会话统计信息条内容行：轮数 / 步数 / 上一轮与平均 tps / 累计输入 / 输出 /
 * 客户端签名状态。只统计主会话（main_turn）口径，子代理不混入。
 *
 * 数据合成：live 部分来自进程内 session-debug 快照（主轮请求级，处理中 1s /
 * 空闲 5s 刷新），持久部分来自 v4/conversation/usage（SQLite model_usage 聚合，
 * 重启后仍在）。本组件只是内容行，容器由输入壳提供（ConversationComposer 的
 * rounded-2xl 卡片顶栏 + 分隔线），圆角/背景与输入框天然一致，浅色/暗色主题
 * 走语义 token 自动跟随。
 */
export function SessionStatsBar({
  sessionId,
  workspacePath,
  workspaceIdentity,
  active,
}: {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 会话处理中 1s 刷新，空闲 5s：常驻组件不能对 session/debug 保持 1Hz 轮询。 */
  active: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const debugState = useSessionDebug({
    workspacePath,
    workspaceIdentity,
    taskId: sessionId,
    enabled: Boolean(sessionId),
    refreshIntervalMs: active ? 1000 : 5000,
  });
  const { usage } = useTaskUsageStats({
    workspacePath,
    workspaceIdentity,
    taskId: sessionId,
    refreshKey: debugState.cache?.hitRateRequestCount,
  });

  const items = useMemo(() => {
    // 轮数取持久与 live 的较大者：正在跑的第一轮 turn_usage 还没落库时用 live 补位，
    // 避免显示「0 轮」。步数只有持久口径（工具调用执行数，轮结束落库）。
    const turns = Math.max(usage?.turnCount ?? 0, debugState.cache?.hitRateRequestCount ?? 0);
    const steps = usage?.toolCallCount ?? 0;
    const liveRounds = debugState.rounds;
    const lastRound = liveRounds.length > 0 ? liveRounds[liveRounds.length - 1] : undefined;
    const lastTps = lastRound?.tokensPerSecond ?? usage?.lastRoundTokensPerSecond ?? null;
    const averageTps = usage?.averageTokensPerSecond ?? null;
    const inputTokens = usage?.primaryInputTokens ?? debugState.cache?.totalInputTokens ?? 0;
    const outputTokens = usage?.primaryOutputTokens ?? 0;
    return { turns, steps, lastTps, averageTps, inputTokens, outputTokens };
  }, [debugState.cache, debugState.rounds, usage]);

  const clientSigning = debugState.latestClientSigning ?? usage?.lastClientSigning ?? null;
  const hasData =
    items.turns > 0 || items.inputTokens > 0 || items.outputTokens > 0 || clientSigning !== null;
  if (!sessionId || !hasData) {
    return null;
  }

  const compact = (value: number | null | undefined): string | undefined => {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: 1,
      notation: "compact",
    }).format(value);
  };
  const tps = (value: number | null | undefined): string | undefined => {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  };

  const turnsText =
    items.turns > 0
      ? intl.formatMessage({ id: "sessionStats.turns" }, { count: items.turns })
      : undefined;
  const stepsText =
    items.steps > 0
      ? intl.formatMessage({ id: "sessionStats.steps" }, { count: items.steps })
      : undefined;
  const lastTpsText = tps(items.lastTps);
  const avgTpsText = tps(items.averageTps);
  const inputText = compact(items.inputTokens);
  const outputText = compact(items.outputTokens);
  const segments: string[] = [
    ...(turnsText ? [turnsText] : []),
    ...(stepsText ? [stepsText] : []),
    ...(lastTpsText
      ? [intl.formatMessage({ id: "sessionStats.lastTps" }, { value: lastTpsText })]
      : []),
    ...(avgTpsText
      ? [intl.formatMessage({ id: "sessionStats.avgTps" }, { value: avgTpsText })]
      : []),
    ...(inputText ? [intl.formatMessage({ id: "sessionStats.input" }, { value: inputText })] : []),
    ...(outputText
      ? [intl.formatMessage({ id: "sessionStats.output" }, { value: outputText })]
      : []),
  ];

  const signed = clientSigning?.kind === "signed_sent";
  const kindLabel = clientSigning
    ? intl.formatMessage({ id: signingKindLabelId(clientSigning.kind) })
    : null;

  return (
    <div
      className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-0.5 text-ui-xs text-foreground-subtle"
      data-testid="session-stats-bar"
    >
      {segments.map((segment) => (
        <span key={segment} className="whitespace-nowrap font-mono">
          {segment}
        </span>
      ))}
      {clientSigning ? (
        <span
          className={`inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-full border border-border bg-surface px-1.5 py-px font-medium leading-normal ${
            signed ? "text-green-600 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400"
          }`}
          title={`${signed ? intl.formatMessage({ id: "sidebar.signing.tooltip.signed" }) : intl.formatMessage({ id: "sidebar.signing.tooltip.unsigned" }, { reason: clientSigning.reason ?? kindLabel ?? "" })}\n${intl.formatMessage({ id: "sidebar.signing.tooltip.detail" })}`}
          data-testid="session-stats-signing-badge"
          data-signing-kind={clientSigning.kind}
          data-signing-attention={isSigningAttentionKind(clientSigning.kind) ? "true" : "false"}
        >
          {signed ? (
            <BadgeCheck className="size-3" aria-hidden="true" />
          ) : (
            <ShieldAlert className="size-3" aria-hidden="true" />
          )}
          <span className="truncate">
            {intl.formatMessage({
              id: signed ? "sidebar.signing.signed" : "sidebar.signing.unsigned",
            })}
          </span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * 子代理迷你统计条：渲染在每个子智能体行下方，只展示该子代理自己的用量
 * （childSessionId 在 model_usage/turn_usage 里是独立 session_id，直接查询即天然
 * 隔离主会话数据）。只用持久聚合（runtime 不在场不拉起，existing-only），
 * 无 live 轮询；数据未落库或 runtime 已回收时整条隐藏。
 */
export function SubagentStatsBar({
  childSessionId,
  workspacePath,
  workspaceIdentity,
}: {
  childSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const { usage } = useTaskUsageStats({
    workspacePath,
    workspaceIdentity,
    taskId: childSessionId,
    refreshKey: undefined,
  });

  if (!usage) return null;
  const compact = (value: number | null | undefined): string | undefined => {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: 1,
      notation: "compact",
    }).format(value);
  };
  const tps = (value: number | null | undefined): string | undefined => {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  };

  // 子会话行的 query_source 全是 subagent：primary*/turnCount/toolCallCount/tps
  // 在 child 查询下即子代理口径（tps 聚合已放宽到 subagent 行）。
  const turnsText =
    (usage.turnCount ?? 0) > 0
      ? intl.formatMessage({ id: "sessionStats.turns" }, { count: usage.turnCount ?? 0 })
      : undefined;
  const stepsText =
    (usage.toolCallCount ?? 0) > 0
      ? intl.formatMessage({ id: "sessionStats.steps" }, { count: usage.toolCallCount ?? 0 })
      : undefined;
  const avgTpsText = tps(usage.averageTokensPerSecond);
  const inputText = compact(usage.primaryInputTokens);
  const outputText = compact(usage.primaryOutputTokens);
  const segments: string[] = [
    ...(turnsText ? [turnsText] : []),
    ...(stepsText ? [stepsText] : []),
    ...(avgTpsText
      ? [intl.formatMessage({ id: "sessionStats.avgTps" }, { value: avgTpsText })]
      : []),
    ...(inputText ? [intl.formatMessage({ id: "sessionStats.input" }, { value: inputText })] : []),
    ...(outputText
      ? [intl.formatMessage({ id: "sessionStats.output" }, { value: outputText })]
      : []),
  ];
  const clientSigning = usage.lastClientSigning ?? null;
  const hasData = segments.length > 0 || clientSigning !== null;
  if (!hasData) return null;

  const signed = clientSigning?.kind === "signed_sent";

  return (
    <div className="flex justify-end pr-4 pb-1">
      <div
        className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-0.5 rounded-lg border border-border bg-background px-2 py-0.5 text-ui-xs text-foreground-subtle"
        data-testid="subagent-stats-bar"
        data-child-session-id={childSessionId}
      >
        {segments.map((segment) => (
          <span key={segment} className="whitespace-nowrap font-mono">
            {segment}
          </span>
        ))}
        {clientSigning ? (
          <span
            className={`inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-full border border-border bg-surface px-1.5 py-px font-medium leading-normal ${
              signed ? "text-green-600 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400"
            }`}
            title={
              signed
                ? intl.formatMessage({ id: "sidebar.signing.tooltip.signed" })
                : intl.formatMessage(
                    {
                      id: "sidebar.signing.tooltip.unsigned",
                    },
                    { reason: clientSigning.reason ?? "" },
                  )
            }
            data-signing-kind={clientSigning.kind}
          >
            {signed ? (
              <BadgeCheck className="size-3" aria-hidden="true" />
            ) : (
              <ShieldAlert className="size-3" aria-hidden="true" />
            )}
            <span className="truncate">
              {intl.formatMessage({
                id: signed ? "sidebar.signing.signed" : "sidebar.signing.unsigned",
              })}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
