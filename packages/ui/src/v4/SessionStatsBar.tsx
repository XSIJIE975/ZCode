import { BadgeCheck, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";
import { useTaskUsageStats } from "@/hooks/useTaskUsageStats.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isSigningAttentionKind,
  signingKindLabelId,
} from "@/lib/clientSigningLabels.js";

/**
 * 会话统计信息条（输入框上方常驻）：轮数 / 步数 / 上一轮与平均 tps /
 * 输入 / 输出 / 缓存读 / 命中率 / 客户端签名状态。
 *
 * 数据合成：live 部分来自进程内 session-debug 快照（1s 级刷新），持久部分来自
 * v4/conversation/usage（SQLite model_usage/turn_usage 聚合，重启后仍在）。
 * 历史会话冷启动时 live 为空，全部由持久数据补位——签名徽标同理（live
 * latestClientSigning 优先，回落到落库的 lastClientSigning）。
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
    const turns = usage?.turnCount ?? 0;
    const steps = usage?.toolCallCount ?? 0;
    const liveRounds = debugState.rounds;
    const lastRound = liveRounds.length > 0 ? liveRounds[liveRounds.length - 1] : undefined;
    const lastTps = lastRound?.tokensPerSecond ?? usage?.lastRoundTokensPerSecond ?? null;
    const averageTps = usage?.averageTokensPerSecond ?? null;
    // 输入/缓存优先用 live（口径与开发者工具面板一致），冷启动回落持久聚合。
    const liveCache = debugState.cache;
    const inputTokens =
      liveCache && liveCache.hitRateRequestCount > 0
        ? liveCache.totalInputTokens
        : (usage?.mainTurnInputTokens ?? 0);
    const cacheReadTokens =
      liveCache && liveCache.hitRateRequestCount > 0
        ? liveCache.totalCacheReadTokens
        : (usage?.mainTurnCacheReadTokens ?? 0);
    const outputTokens = usage?.mainTurnOutputTokens ?? 0;
    const hitRate =
      liveCache && liveCache.hitRateRequestCount > 0
        ? liveCache.hitRate
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null;
    return { turns, steps, lastTps, averageTps, inputTokens, outputTokens, cacheReadTokens, hitRate };
  }, [debugState.cache, debugState.rounds, usage]);

  const clientSigning = debugState.latestClientSigning ?? usage?.lastClientSigning ?? null;
  const hasData =
    items.turns > 0 ||
    items.inputTokens > 0 ||
    items.outputTokens > 0 ||
    clientSigning !== null;
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
  const percent = (value: number | null | undefined): string | undefined => {
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
      style: "percent",
    }).format(value);
  };

  const lastTpsText = tps(items.lastTps);
  const avgTpsText = tps(items.averageTps);
  const inputText = compact(items.inputTokens);
  const outputText = compact(items.outputTokens);
  const cacheReadText = compact(items.cacheReadTokens);
  const hitRateText = percent(items.hitRate);
  const segments: string[] = [
    intl.formatMessage({ id: "sessionStats.turns" }, { count: items.turns }),
    intl.formatMessage({ id: "sessionStats.steps" }, { count: items.steps }),
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
    ...(cacheReadText
      ? [intl.formatMessage({ id: "sessionStats.cacheRead" }, { value: cacheReadText })]
      : []),
    ...(hitRateText
      ? [intl.formatMessage({ id: "sessionStats.hitRate" }, { value: hitRateText })]
      : []),
  ];

  const signed = clientSigning?.kind === "signed_sent";
  const kindLabel = clientSigning
    ? intl.formatMessage({ id: signingKindLabelId(clientSigning.kind) })
    : null;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-ui-xs text-foreground-subtle"
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
          title={`${signed ? intl.formatMessage({ id: "sidebar.signing.tooltip.signed" }) : intl.formatMessage({ id: "sidebar.signing.tooltip.unsigned" }, { reason: clientSigning.reason ?? (kindLabel ?? "") })}\n${intl.formatMessage({ id: "sidebar.signing.tooltip.detail" })}`}
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
