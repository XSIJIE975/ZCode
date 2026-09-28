import { RELAY_MAX_FRAME_BYTES } from "./relayProtocol.js";
import {
  RELAY_PENDING_OUTBOUND_LIMIT,
  RELAY_PENDING_OUTBOUND_TTL_MS,
} from "./relayTransportContract.js";

// 未配对期间的出站缓冲：FIFO、限长、限时，并按**物理帧**字节判超限。
//
// 为什么必须限时：断线几分钟后链路恢复，把当时排下的 RPC 回执原样推给终端，
// 比直接丢掉更容易造成"看起来连上了但内容不对"。
// 为什么要量物理帧：待发报文最终会被套上 {type:"data",payload,client_ts} 再发，
// 只量裸 payload 会在套壳后越限，导致队头永远发不出去、整条队列卡死。

/** 量的是**物理帧**（套上 `{type:"data",payload,client_ts}` 之后）的字节数，与发行版 prepare() 同口径。 */
export function relayPhysicalFrameBytes(payload: unknown, now: number): number {
  return Buffer.byteLength(JSON.stringify({ type: "data", payload, client_ts: now }), "utf8");
}

export interface RelayPendingOutboundDeps {
  now: () => number;
  isPaired: () => boolean;
  /** 真正把一帧写出去；返回 false 表示当前不可发，flush 应停在这里。 */
  sendFrame: (payload: unknown) => boolean;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
}

export interface RelayPendingOutbound {
  size: () => number;
  /** 返回 true 表示这帧已入队（调用方据此报告"未发出"）。 */
  enqueue: (payload: unknown) => void;
  flush: () => void;
  clear: (reason: string) => void;
}

export function createRelayPendingOutbound(deps: RelayPendingOutboundDeps): RelayPendingOutbound {
  const queue: { payload: unknown; enqueuedAt: number }[] = [];

  const clear = (reason: string): void => {
    if (queue.length === 0) return;
    const droppedCount = queue.length;
    queue.length = 0;
    deps.logger.warn("[web-remote-control] dropped buffered outbound payloads", {
      reason,
      droppedCount,
    });
  };

  const flush = (): void => {
    while (queue.length > 0) {
      const entry = queue[0];
      if (!entry) return;
      if (deps.now() - entry.enqueuedAt > RELAY_PENDING_OUTBOUND_TTL_MS) {
        clear("stale");
        return;
      }
      const bytes = relayPhysicalFrameBytes(entry.payload, deps.now());
      if (bytes > RELAY_MAX_FRAME_BYTES) {
        deps.logger.warn("[web-remote-control] dropped oversize buffered outbound payload", {
          bytes,
          maxBytes: RELAY_MAX_FRAME_BYTES,
        });
        queue.shift();
        continue;
      }
      if (!deps.isPaired()) return;
      // 只有真的写成功才出队；否则停在队头等下一次 flush，不能既不发又丢掉。
      if (!deps.sendFrame(entry.payload)) return;
      queue.shift();
    }
  };

  return {
    size: () => queue.length,
    enqueue: (payload) => {
      if (queue.length >= RELAY_PENDING_OUTBOUND_LIMIT) {
        clear("overflow");
        return;
      }
      queue.push({ payload, enqueuedAt: deps.now() });
    },
    flush,
    clear,
  };
}
