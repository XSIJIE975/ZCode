import {
  ChannelClient,
  ChannelServer,
  MessagePortProtocol,
  type MessagePortLike,
  type IChannel,
  type IMessagePassingProtocol,
  type IServerChannel,
} from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";

// 把窗口 Local Host 的服务面桥接给远控终端。
//
// 拓扑：终端 ──rpc-frame──> relayRpcBridge 的 IMessagePassingProtocol ──> ChannelServer
//       ──逐频道代理──> ChannelClient ──MessagePort──> 窗口 Local Host 的 ChannelServer。
//
// 不重建 ServiceCollection：Host 已经是权威的服务宿主，main 只做协议对协议的双向代理，
// 因此这里不产生第二份状态所有者，也无需跟随 40 个 service 的增删改维护清单。

export interface RelayWorkspaceBridgeOptions {
  /** main 侧端口（已经过 wrapNodeStyleMessagePort 适配）。 */
  hostPort: MessagePortLike;
  /** relay 侧协议（createRelayRpcBridge 产出），终端是这一端的 client。 */
  relayProtocol: IMessagePassingProtocol;
  /**
   * 需要暴露的频道名。默认取 ServiceChannels 全量：远控终端与 renderer 看到的是同一套
   * Host 服务面，行为差异由 Host 侧 connection scope 按 clientMode 决定，而不是在这里裁剪。
   */
  channelNames?: readonly string[];
  /** 终端侧 attachment 的 clientMode，由 Host 的 connection scope 解释。 */
  onDispose?: (reason: Error | undefined) => void;
}

export interface RelayWorkspaceBridge {
  /** 显式放行 Initialize；必须在 relay 桥已建立（workspace-bridge-ready）之后调用。 */
  open: () => void;
  dispose: (reason?: Error) => void;
}

/**
 * `IChannel`（call(command,args,ct) / listen(event,args)）适配到
 * `IServerChannel`（多一个 ctx 首参）。远控不引入新的上下文语义，ctx 直接丢弃。
 */
function asServerChannel(channel: IChannel): IServerChannel<unknown> {
  return {
    call: (_context, command, argument, cancellationToken) =>
      channel.call(command, argument, cancellationToken),
    listen: (_context, event, argument) => channel.listen(event, argument),
  };
}

export function createRelayWorkspaceBridge(
  options: RelayWorkspaceBridgeOptions,
): RelayWorkspaceBridge {
  const hostProtocol = new MessagePortProtocol(options.hostPort);
  const hostClient = new ChannelClient(hostProtocol);
  // deferInit=true：ChannelServer 构造即发 Initialize 会让终端在桥尚未 ready 时就解锁队列，
  // 与发行版时序不一致，因此改为 open() 时显式放行。
  const server = new ChannelServer(options.relayProtocol, undefined, 1000, true);

  const channelNames =
    options.channelNames ?? Object.values(ServiceChannels as unknown as Record<string, string>);
  for (const name of channelNames) {
    if (typeof name !== "string" || name.length === 0) continue;
    server.registerChannel(name, asServerChannel(hostClient.getChannel(name)) as never);
  }

  let disposed = false;

  return {
    open: () => {
      if (disposed) return;
      server.ready();
    },
    dispose: (reason?: Error) => {
      if (disposed) return;
      disposed = true;
      try {
        server.dispose();
      } finally {
        hostClient.dispose(reason);
        options.onDispose?.(reason);
      }
    },
  };
}

/** 供上层做连接期诊断：确认代理了哪些频道。 */
export function listDefaultRelayBridgeChannels(): string[] {
  return Object.values(ServiceChannels as unknown as Record<string, string>);
}
