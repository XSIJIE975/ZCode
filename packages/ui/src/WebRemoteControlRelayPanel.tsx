import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Copy, Loader2, RefreshCw, Smartphone, Unlink } from "lucide-react";
import { WEB_REMOTE_CONTROL_DEFAULT_STATUS } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  useWebRemoteControlStatus,
  webRemoteControlFailureMessageId,
  webRemoteControlStatusTagText,
  webRemoteControlViewStatusOf,
  type WebRemoteControlViewStatus,
} from "@/webRemoteControlView.js";

// 「手机扫码连接」卡片：桌面主动外连厂商 relay，手机扫码后成为该窗口 Host 的又一个客户端。
// 布局、状态词与配色对齐官方发行版；Web 构建没有设备端，平台能力缺省时整块不渲染。

const QR_SIZE_PX = 256;

const STATUS_LABEL_KEY: Record<WebRemoteControlViewStatus, string> = {
  idle: "webRemoteControl.status.idle",
  starting: "webRemoteControl.status.starting",
  connecting: "webRemoteControl.status.connecting",
  running: "webRemoteControl.status.running",
  active: "webRemoteControl.status.active",
  error: "webRemoteControl.status.error",
};

const STATUS_DETAIL_KEY: Record<WebRemoteControlViewStatus, string> = {
  idle: "webRemoteControl.statusDetail.idle",
  starting: "webRemoteControl.statusDetail.starting",
  connecting: "webRemoteControl.statusDetail.connecting",
  running: "webRemoteControl.statusDetail.running",
  active: "webRemoteControl.statusDetail.active",
  error: "webRemoteControl.statusDetail.error",
};

/** 圆点配色与发行版一致：错误红、已连绿、未开启灰，其余一律警示色。 */
function dotClassOf(status: WebRemoteControlViewStatus): string {
  if (status === "error") return "bg-destructive";
  if (status === "active") return "bg-success";
  if (status === "idle") return "bg-border";
  return "bg-warning";
}

export function WebRemoteControlRelayPanel({
  open,
  onStopped,
}: {
  open: boolean;
  /** 停止成功后由弹窗负责关闭自己，与发行版一致。 */
  onStopped: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const requestConfirmation = useConfirmDialog();
  const { status, supported, setStatus } = useWebRemoteControlStatus();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 打开弹窗即启动：发行版没有「启用」按钮，卡里只有「停止」，会话是在弹窗打开时起来的。
  // 只认 false→true 这一次跳变：否则点停止后 status.enabled 变 false，
  // 这个 effect 会立刻把刚停掉的会话又启动一遍，表现成「停止反而刷出了新二维码」。
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened || !supported || status.enabled) return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const next = await platform.enableWebRemoteControl?.();
        if (!cancelled && next) setStatus(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          toast(intl.formatMessage({ id: "webRemoteControl.startFailed" }, { error: message }));
          logger.warn("[WebRemoteControlRelayPanel] 启动远控失败", { message });
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supported, status.enabled, platform, intl, setStatus]);

  // 配对链接含一次性口令，只在前台渲染成二维码，不写日志、不落持久化。
  useEffect(() => {
    const pairingUrl = status.pairingUrl;
    if (!pairingUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(pairingUrl, { margin: 1, width: QR_SIZE_PX })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch((error: unknown) => {
        // 二维码生成失败不阻断流程，用户还能用「复制链接」。
        logger.warn("[WebRemoteControlRelayPanel] 二维码生成失败", {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [status.pairingUrl]);

  const run = useCallback(
    async (action: "disable" | "reset") => {
      setBusy(true);
      try {
        const next =
          action === "reset"
            ? await platform.resetWebRemoteControlPairing?.()
            : await platform.disableWebRemoteControl?.();
        if (action === "reset") {
          if (next && mountedRef.current) setStatus(next);
          toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.success" }));
        } else {
          // 停止后本地先归位再关窗：会话已销毁，留着弹窗只会显示一个已经不存在的二维码。
          if (mountedRef.current) setStatus(WEB_REMOTE_CONTROL_DEFAULT_STATUS);
          onStopped();
          toast(intl.formatMessage({ id: "webRemoteControl.stopSuccess" }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(
          intl.formatMessage(
            {
              id:
                action === "reset"
                  ? "webRemoteControl.refreshQr.failed"
                  : "webRemoteControl.stopFailed",
            },
            { error: message },
          ),
        );
        logger.warn("[WebRemoteControlRelayPanel] 远控操作失败", { action, message });
      } finally {
        setBusy(false);
      }
    },
    [platform, intl, onStopped, setStatus],
  );

  /**
   * 刷新二维码先过全局确认弹窗（confirmDialogStore + ConfirmDialogHost），和发行版一致：
   * 「取消 + esc / 确认 + ⏎」的键位提示、autoFocus 与全局 Enter 兜底都由那套机制提供，
   * 不再自建一份 AlertDialog 分支，避免同一个确认手势在仓库里有两条实现。
   * 没有会话时同样先确认再执行 —— main 的 resetPairing 会清凭据并新建会话，
   * 语义就是「重新配对」，不需要为 idle 状态再开一条绕过确认的 enable 路径。
   */
  const refreshPairing = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "webRemoteControl.refreshQr.confirmTitle" }),
      description: intl.formatMessage({
        id: "webRemoteControl.refreshQr.confirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "webRemoteControl.refreshQr" }),
    });
    if (!confirmed) return;
    await run("reset");
  }, [requestConfirmation, intl, run]);

  const copyLink = useCallback(async () => {
    const url = status.pairingUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLink.copied" }));
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "webRemoteControl.copyLinkFailed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }, [status.pairingUrl, intl]);

  if (!supported) return null;

  const viewStatus = webRemoteControlViewStatusOf(status);
  const label = intl.formatMessage({ id: STATUS_LABEL_KEY[viewStatus] });
  const detail = intl.formatMessage({ id: STATUS_DETAIL_KEY[viewStatus] });
  const tag = webRemoteControlStatusTagText(status, intl.formatMessage);

  return (
    <section
      data-testid="web-remote-control-scan-card"
      className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4"
    >
      <div className="mb-4 flex items-start gap-2">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 space-y-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "webRemoteControl.mobileQr.title" })}
          </div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.mobileQr.description" })}
          </p>
        </div>
      </div>

      <div
        data-testid="web-remote-control-connection-card"
        className="mb-3 rounded-lg bg-surface px-3 py-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="text-ui-base font-medium text-foreground">{label}</div>
              <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-card px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                <span className={`size-1.5 shrink-0 rounded-full ${dotClassOf(viewStatus)}`} />
                <span className="truncate">{tag}</span>
              </div>
            </div>
            <div className="text-ui-base/relaxed text-foreground-subtle">{detail}</div>
          </div>
          {busy ? (
            <Loader2 className="size-4 animate-spin text-foreground-subtle" />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="default"
              className="shrink-0 gap-2 enabled:cursor-pointer"
              // Bugfix: 停用判据原本是 `!status.enabled`，只覆盖 state==="disabled"；
              // 会话已建但传输层回到 idle 时 enabled 仍为 true，于是「没有可停止的配对」却点得动。
              // 发行版按展示档判 idle（其 status 枚举就是视图 6 档），这里改读同一份 viewStatus，
              // 让 disabled|idle 一起禁用，和状态词「未开启」保持一致。
              disabled={viewStatus === "idle"}
              onClick={() => void run("disable")}
            >
              <Unlink className="size-3.5" />
              {intl.formatMessage({ id: "webRemoteControl.stop" })}
            </Button>
          )}
        </div>
        {status.failure ? (
          <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-ui-base/relaxed text-destructive">
            <p>
              {intl.formatMessage({ id: webRemoteControlFailureMessageId(status.failure.reason) })}
            </p>
            {status.failure.message &&
            status.failure.message !==
              intl.formatMessage({
                id: webRemoteControlFailureMessageId(status.failure.reason),
              }) ? (
              <p className="mt-1 text-ui-xs/relaxed opacity-80">{status.failure.message}</p>
            ) : null}
          </div>
        ) : viewStatus === "error" ? (
          <p className="mt-3 text-ui-base/relaxed text-destructive">
            {intl.formatMessage({ id: "webRemoteControl.statusDetail.error" })}
          </p>
        ) : null}

        <div
          data-testid="web-remote-control-copy-link-row"
          className="mt-3 flex min-h-10 flex-wrap items-center gap-3 border-t border-border pt-3"
        >
          <div className="min-w-48 flex-1 text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.copyLink.description" })}
          </div>
          {/* 发行版刷新只受"进行中"约束，并且任何状态都先过二次确认；idle 下确认完就走 reset，
              main 会清凭据并新建会话，不再需要 UI 侧替它分一条 enable 分支。 */}
          <Button
            type="button"
            variant="outline"
            size="default"
            className="shrink-0 gap-2 enabled:cursor-pointer"
            disabled={busy}
            onClick={() => void refreshPairing()}
          >
            <RefreshCw className="size-3.5" />
            {intl.formatMessage({ id: "webRemoteControl.refreshQr" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="default"
            className="shrink-0 gap-2 enabled:cursor-pointer"
            disabled={!status.pairingUrl || busy}
            onClick={() => void copyLink()}
          >
            <Copy className="size-3.5" />
            {intl.formatMessage({ id: "webRemoteControl.copyLink" })}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-background-alt p-4">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
            className="size-64 max-w-full rounded-lg bg-white p-3"
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-center text-ui-base text-foreground-subtle">
            <Loader2 className="size-5 animate-spin" />
            <span>{intl.formatMessage({ id: "webRemoteControl.generating" })}</span>
          </div>
        )}
      </div>
    </section>
  );
}
