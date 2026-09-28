import { useState } from "react";
import { Smartphone } from "lucide-react";
import { resolveWorkspaceTelemetryDetail } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { logger } from "@/logger.js";
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";
import { useWebRemoteControlStatus, webRemoteControlTriggerView } from "@/webRemoteControlView.js";

export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [webRemoteControlOpen, setWebRemoteControlOpen] = useState(false);
  const { status } = useWebRemoteControlStatus();
  const triggerView = webRemoteControlTriggerView(status);
  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        description={intl.formatMessage({ id: triggerView.tooltipId })}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            // 与发行版对齐：入口点击补一条 view 埋点（elementName/region/type 逐字段照搬其
            // web_remote_control_entry_view 事件）。detail 只带由工作区身份推导出的低基数枚举，
            // 不含路径、配对链接与任何用户数据；埋点是旁路，失败由 reportAppTelemetryEvent 吞掉。
            void reportAppTelemetryEvent(
              platform,
              {
                elementName: "web_remote_control_entry_view",
                eventRegion: "web_remote_control",
                eventType: "view",
                eventExtraDetail: resolveWorkspaceTelemetryDetail({ workspaceIdentity }),
              },
              "web-remote-control-entry",
            );
            logger.info("[WorkspaceWebRemoteControlTrigger] 打开远程控制弹层", {
              workspacePath,
              workspaceIdentity: workspaceIdentity ?? "none",
            });
            setWebRemoteControlOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "webRemoteControl.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
        >
          {/* 图标配色即远控状态：灰=未开启，黄=启动中/等待手机/手机连接中，绿=手机已连接，红=失败。 */}
          <Smartphone className={cn("size-4", triggerView.iconClassName)} />
          {compact ? (
            <span className="sr-only">
              {intl.formatMessage({ id: "webRemoteControl.trigger" })}
            </span>
          ) : (
            intl.formatMessage({ id: "webRemoteControl.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={webRemoteControlOpen}
        onOpenChange={setWebRemoteControlOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
      />
    </>
  );
}
