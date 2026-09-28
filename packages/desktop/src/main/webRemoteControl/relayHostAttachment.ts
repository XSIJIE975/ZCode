import {
  wrapNodeStyleMessagePort,
  type MessagePortLike,
  type NodeStyleMessagePort,
} from "@zcode/rpc";
import { HostMessageTypes } from "@zcode/shared";
import type { ZCodeAgentV4ClientMode } from "@zcode/services";
import { randomUUID } from "node:crypto";

// 让 main 取得窗口 Local Host 的服务端口。
//
// Host 侧 `host/index.ts` 的 AttachServicePort 已原生支持 `scope.kind === "local"`
// （resolveScope 直接返回该窗口的 activeServices，并在数据库未就绪时排队 attachment），
// 因此这里不需要改 Host，只需按同一契约发一条消息。
//
// 注意：不能复用 desktopHostProcess 的 onPortReady —— 那条端口是给 renderer 的，
// main 拿走会让窗口失去服务面。远控必须另开一条 MessageChannel 作为独立 attachment。

export type RelayHostMessagePort = NodeStyleMessagePort;

export interface RelayHostProcess {
  postMessage(message: unknown, transfer?: unknown[]): void;
}

export interface AttachLocalHostPortParams {
  host: RelayHostProcess;
  createMessageChannel: () => { port1: RelayHostMessagePort; port2: RelayHostMessagePort };
  /**
   * 远控终端使用可恢复链路语义；Host 的 connection scope 会据此选择
   * `web-remote-replayable` 的投递画像，与桌面 `desktop-continuous` 严格区分。
   */
  clientMode?: ZCodeAgentV4ClientMode;
}

export interface LocalHostAttachment {
  attachmentId: string;
  /** 已适配为 Web 标准端口，可直接交给 MessagePortProtocol / connectViaMessagePort。 */
  port: MessagePortLike;
  dispose: () => void;
}

export function attachLocalHostServicePort(params: AttachLocalHostPortParams): LocalHostAttachment {
  const { host, createMessageChannel } = params;
  const clientMode = params.clientMode ?? "web-remote-replayable";
  const attachmentId = randomUUID();
  const { port1, port2 } = createMessageChannel();

  host.postMessage(
    {
      type: HostMessageTypes.AttachServicePort,
      requestId: randomUUID(),
      attachmentId,
      clientMode,
      scope: { kind: "local" },
    },
    [port2],
  );

  let disposed = false;
  return {
    attachmentId,
    port: wrapNodeStyleMessagePort(port1),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // 先通知 Host 撤下 attachment，再关本地端口，避免 Host 侧注册表残留导致
      // 同一 attachmentId 的旧端口继续接收路由。
      try {
        host.postMessage({ type: HostMessageTypes.DetachServicePort, attachmentId });
      } catch {
        // Host 已退出：注册表随进程消失，无需补偿。
      }
      port1.close();
    },
  };
}
