import { BadgeCheck, Check, Settings2, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";
import { useTaskUsageStats } from "@/hooks/useTaskUsageStats.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isSigningAttentionKind, signingKindLabelId } from "@/lib/clientSigningLabels.js";
import {
  useSessionStatsSegments,
  type SessionStatsSegments,
} from "@/lib/sessionStatsPreference.js";

/** 签名状态图标徽标：只留图标（size-3.5），完整结论与原因放 title 悬浮提示。
 * 视觉两类：signed_sent = 绿色对勾；其余五种 kind = 黄色警示（原因见 title）。 */
export function SigningBadge({
  kind,
  reason,
  testId,
}: {
  kind: string;
  reason?: string;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const signed = kind === "signed_sent";
  const kindLabel = intl.formatMessage({ id: signingKindLabelId(kind) });
  const tooltip = signed
    ? intl.formatMessage({ id: "sidebar.signing.tooltip.signed" })
    : intl.formatMessage(
        { id: "sidebar.signing.tooltip.unsigned" },
        { reason: reason ?? kindLabel },
      );
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full p-0.5 leading-none ${
        signed ? "text-green-600 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400"
      }`}
      title={`${tooltip}\n${intl.formatMessage({ id: "sidebar.signing.tooltip.detail" })}`}
      aria-label={kindLabel}
      role="img"
      {...(testId ? { "data-testid": testId } : {})}
      data-signing-kind={kind}
      data-signing-attention={isSigningAttentionKind(kind) ? "true" : "false"}
    >
      {signed ? (
        <BadgeCheck className="size-3.5" aria-hidden="true" />
      ) : (
        <ShieldAlert className="size-3.5" aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * 会话统计信息条内容行：轮数 / 步数 / 上一轮与平均 tps / 累计输入 / 输出 /
 * 客户端签名状态。只统计主会话（main_turn）口径，子代理不混入。
 *
 * 数据合成：live 部分来自进程内 session-debug 快照（主轮请求级，处理中 1s /
 * 空闲 5s 刷新），持久部分来自 v4/conversation/usage（SQLite model_usage 聚合，
 * 重启后仍在）。本组件只是内容行，容器由输入卡片提供（ChatPromptEditor 的
 * rounded-2xl bg-input 卡顶栏），圆角/背景与输入框天然一致。
 *
 * 窄窗口渐进精简（容器查询，沿用 GitActionMenu workspace-header 的做法）：
 * 输入/输出用 ↑/↓ 符号替代文字标签；<720px 隐藏「上一轮 tps」；<520px 只留
 * 轮/步/签名图标。全部数值带 title 悬浮全称，隐藏的信息开发者工具仍可查。
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
  const { segments } = useSessionStatsSegments();
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
    segments.turns && items.turns > 0
      ? intl.formatMessage({ id: "sessionStats.turns" }, { count: items.turns })
      : undefined;
  const stepsText =
    segments.steps && items.steps > 0
      ? intl.formatMessage({ id: "sessionStats.steps" }, { count: items.steps })
      : undefined;
  const lastTpsText = segments.lastTps ? tps(items.lastTps) : undefined;
  const avgTpsText = segments.avgTps ? tps(items.averageTps) : undefined;
  const inputText = segments.input ? compact(items.inputTokens) : undefined;
  const outputText = segments.output ? compact(items.outputTokens) : undefined;

  return (
    <div
      className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-0.5 text-ui-xs text-foreground-subtle"
      data-testid="session-stats-bar"
    >
      {turnsText ? (
        <span
          className="whitespace-nowrap font-mono"
          title={intl.formatMessage({ id: "sessionStats.turns" }, { count: items.turns })}
        >
          {turnsText}
        </span>
      ) : null}
      {stepsText ? (
        <span
          className="whitespace-nowrap font-mono"
          title={intl.formatMessage({ id: "sessionStats.steps" }, { count: items.steps })}
        >
          {stepsText}
        </span>
      ) : null}
      {lastTpsText ? (
        <span
          className="hidden whitespace-nowrap font-mono @min-[720px]/composer:inline"
          title={intl.formatMessage({ id: "sessionStats.lastTps" }, { value: lastTpsText })}
        >
          {intl.formatMessage({ id: "sessionStats.label.lastTps" })} {lastTpsText} tok/s
        </span>
      ) : null}
      {avgTpsText ? (
        <span
          className="whitespace-nowrap font-mono @max-[520px]/composer:hidden"
          title={intl.formatMessage({ id: "sessionStats.avgTps" }, { value: avgTpsText })}
        >
          {intl.formatMessage({ id: "sessionStats.label.avgTps" })} {avgTpsText} tok/s
        </span>
      ) : null}
      {inputText ? (
        <span
          className="whitespace-nowrap font-mono @max-[520px]/composer:hidden"
          title={intl.formatMessage({ id: "sessionStats.input" }, { value: inputText })}
        >
          ↑{inputText}
        </span>
      ) : null}
      {outputText ? (
        <span
          className="whitespace-nowrap font-mono @max-[520px]/composer:hidden"
          title={intl.formatMessage({ id: "sessionStats.output" }, { value: outputText })}
        >
          ↓{outputText}
        </span>
      ) : null}
      {clientSigning ? (
        <SigningBadge
          kind={clientSigning.kind}
          reason={clientSigning.reason}
          testId="session-stats-signing-badge"
        />
      ) : null}
      <SessionStatsConfigButton />
    </div>
  );
}

/** 统计条配置入口：低对比齿轮 + Popover 勾选面板，改动即时生效并存 localStorage。 */
function SessionStatsConfigButton() {
  const { intl } = useZCodeIntl();
  const { segments, update, reset } = useSessionStatsSegments();
  const rows: Array<{ key: keyof SessionStatsSegments; labelId: string; descId: string }> = [
    {
      key: "turns",
      labelId: "sessionStats.config.turns",
      descId: "sessionStats.config.desc.turns",
    },
    {
      key: "steps",
      labelId: "sessionStats.config.steps",
      descId: "sessionStats.config.desc.steps",
    },
    {
      key: "lastTps",
      labelId: "sessionStats.config.lastTps",
      descId: "sessionStats.config.desc.lastTps",
    },
    {
      key: "avgTps",
      labelId: "sessionStats.config.avgTps",
      descId: "sessionStats.config.desc.avgTps",
    },
    {
      key: "input",
      labelId: "sessionStats.config.input",
      descId: "sessionStats.config.desc.input",
    },
    {
      key: "output",
      labelId: "sessionStats.config.output",
      descId: "sessionStats.config.desc.output",
    },
  ];
  return (
    <Popover>
      <PopoverTrigger
        className="shrink-0 rounded p-0.5 text-foreground-subtlest opacity-60 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none"
        title={intl.formatMessage({ id: "sessionStats.config.title" })}
        aria-label={intl.formatMessage({ id: "sessionStats.config.title" })}
        data-testid="session-stats-config"
      >
        <Settings2 className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-border px-3 py-2 text-ui-xs font-medium text-foreground">
          {intl.formatMessage({ id: "sessionStats.config.title" })}
        </div>
        <div className="flex flex-col p-1">
          {rows.map((row) => (
            <button
              key={row.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={segments[row.key]}
              onClick={() => update({ [row.key]: !segments[row.key] })}
              className="flex cursor-default items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
            >
              {/* 装饰性勾选框：整行 button 已是可访问控件，内部只做视觉。 */}
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
                  segments[row.key]
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input-border bg-input",
                )}
              >
                {segments[row.key] ? <Check className="size-3" /> : null}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-ui-xs font-medium text-foreground">
                  {intl.formatMessage({ id: row.labelId })}
                </span>
                <span className="text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({ id: row.descId })}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          {/* 签名徽标固定展示，不参与配置（签名状态是诊断关键信息）。 */}
          <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "sessionStats.config.signingFixed" })}
          </span>
          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded px-1.5 py-0.5 text-ui-xs text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none"
          >
            {intl.formatMessage({ id: "sessionStats.config.reset" })}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 子代理迷你统计条：渲染在每个子智能体行下方（左对齐，跟随对话流缩进），
 * 只展示该子代理自己的用量（childSessionId 在 model_usage/turn_usage 里是独立
 * session_id，直接查询即天然隔离主会话数据）。只用持久聚合（runtime 不在场
 * 不拉起，existing-only），无 live 轮询；数据未落库或 runtime 已回收时整条隐藏。
 * 窄窗口（viewport < md）隐藏 tps 与 token 段，只留 轮/步/签名图标。
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
  const { segments } = useSessionStatsSegments();
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
    segments.turns && (usage.turnCount ?? 0) > 0
      ? intl.formatMessage({ id: "sessionStats.turns" }, { count: usage.turnCount ?? 0 })
      : undefined;
  const stepsText =
    segments.steps && (usage.toolCallCount ?? 0) > 0
      ? intl.formatMessage({ id: "sessionStats.steps" }, { count: usage.toolCallCount ?? 0 })
      : undefined;
  const avgTpsText = segments.avgTps ? tps(usage.averageTokensPerSecond) : undefined;
  const inputText = segments.input ? compact(usage.primaryInputTokens) : undefined;
  const outputText = segments.output ? compact(usage.primaryOutputTokens) : undefined;
  const clientSigning = usage.lastClientSigning ?? null;
  const hasData =
    (turnsText ?? stepsText ?? avgTpsText ?? inputText ?? outputText) !== undefined ||
    clientSigning !== null;
  if (!hasData) return null;

  return (
    <div className="flex justify-start py-0.5">
      <div
        className="flex max-w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-lg border border-border bg-background px-2 py-0.5 text-ui-xs text-foreground-subtle"
        data-testid="subagent-stats-bar"
        data-child-session-id={childSessionId}
      >
        {turnsText ? (
          <span className="whitespace-nowrap font-mono" title={turnsText}>
            {turnsText}
          </span>
        ) : null}
        {stepsText ? (
          <span className="whitespace-nowrap font-mono" title={stepsText}>
            {stepsText}
          </span>
        ) : null}
        {avgTpsText ? (
          <span
            className="whitespace-nowrap font-mono max-md:hidden"
            title={intl.formatMessage({ id: "sessionStats.avgTps" }, { value: avgTpsText })}
          >
            {avgTpsText} tok/s
          </span>
        ) : null}
        {inputText ? (
          <span
            className="whitespace-nowrap font-mono max-md:hidden"
            title={intl.formatMessage({ id: "sessionStats.input" }, { value: inputText })}
          >
            ↑{inputText}
          </span>
        ) : null}
        {outputText ? (
          <span
            className="whitespace-nowrap font-mono max-md:hidden"
            title={intl.formatMessage({ id: "sessionStats.output" }, { value: outputText })}
          >
            ↓{outputText}
          </span>
        ) : null}
        {clientSigning ? (
          <SigningBadge kind={clientSigning.kind} reason={clientSigning.reason} />
        ) : null}
      </div>
    </div>
  );
}
