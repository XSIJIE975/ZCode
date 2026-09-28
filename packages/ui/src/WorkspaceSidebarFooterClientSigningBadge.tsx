import { BadgeCheck, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 侧边栏底部常驻的客户端签名状态徽标：跟随当前会话最近一次签名观测。
 * 只在活跃会话产生过签名观测（即走官方 Coding Plan 链路）时显示；
 * 已签名 = 绿色对勾，其余（未签名/验签被拒/降级）= 黄色警示，
 * title 提示原因与明细入口（侧边栏「+」→ 开发者工具 → 网络区）。
 */
export function WorkspaceSidebarFooterClientSigningBadge({
  activeTaskId,
  workspacePath,
  workspaceIdentity,
}: {
  activeTaskId?: string | null;
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const debugState = useSessionDebug({
    workspacePath: workspacePath ?? "",
    workspaceIdentity,
    taskId: activeTaskId ?? null,
    enabled: Boolean(workspacePath && activeTaskId),
  });
  const latestSigningEntry = useMemo(() => {
    const entries = debugState.networkEntries ?? [];
    // 签名观测并入同 requestId 的请求条目（找不到时才独立成行），
    // 倒序找最近一条携带 clientSigning 的条目即最近一次签名结果。
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry: (typeof entries)[number] | undefined = entries[index];
      if (entry?.clientSigning) {
        return entry;
      }
    }
    return null;
  }, [debugState.networkEntries]);

  if (!latestSigningEntry?.clientSigning) {
    return null;
  }

  const clientSigning = latestSigningEntry.clientSigning;
  const signed = clientSigning.kind === "signed_sent";
  const kindLabel = intl.formatMessage({
    id: signingKindLabelId(clientSigning.kind),
  });
  const tooltip = signed
    ? intl.formatMessage({ id: "sidebar.signing.tooltip.signed" })
    : intl.formatMessage(
        { id: "sidebar.signing.tooltip.unsigned" },
        { reason: clientSigning.reason ?? kindLabel },
      );

  return (
    <span
      className={`inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-full border border-border bg-surface px-1 py-px text-ui-xs font-medium leading-normal ${
        signed ? "text-green-600 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400"
      }`}
      title={`${tooltip}\n${intl.formatMessage({ id: "sidebar.signing.tooltip.detail" })}`}
      data-testid="sidebar-client-signing-badge"
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
  );
}

function signingKindLabelId(kind: string): string {
  switch (kind) {
    case "signed_sent":
    case "unsigned_sent":
    case "handshake_failed":
    case "verify_rejected":
    case "bypass_entered":
    case "request_failed_closed":
      return `developerTools.network.signing.kind.${kind}`;
    default:
      return "developerTools.network.signing";
  }
}
