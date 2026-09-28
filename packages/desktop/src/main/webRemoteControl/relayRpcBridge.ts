import { Emitter, VSBuffer, type Event, type IMessagePassingProtocol } from "@zcode/rpc";
import {
  RELAY_TRANSPORT_MAX_FRAGMENTS,
  buildRelayRpcFrameAck,
  encodeRelayRpcFrames,
  type RelayRpcFrame,
  type RelayTransportFrame,
} from "./relayFrameCodec.js";
import { RelayRpcFrameReceiver } from "./relayFrameCodec.js";

// 把 `@zcode/rpc` 的 IMessagePassingProtocol 架在 relay 传输层之上：
// send() 把一条 RPC 报文切成 rpc-frame 发出，入站 rpc-frame 组帧后回 onMessage。
// 这样上层可以直接复用 ChannelServer / ProxyChannel，不必为远控另写一套 RPC。

export const RELAY_RPC_DEFAULT_MAX_PHYSICAL_FRAME_BYTES = 256 * 1024;
export const RELAY_RPC_MAX_BUFFERED_MESSAGES = 50;

export type RelayRpcDegradedReasonCode =
  | "rpc-transport-fault"
  | "rpc-frame-gap"
  | "buffer-overflow"
  | "buffer-timeout";

export interface RelayRpcBridgeContext {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

export interface RelayRpcBridgeOptions {
  context: RelayRpcBridgeContext;
  /** 返回 false 表示链路暂时不可发（未 paired 等），报文进入待发队列。 */
  sendFrame: (frame: RelayTransportFrame) => boolean;
  onDegraded?: (event: { reasonCode: RelayRpcDegradedReasonCode; detail?: string }) => void;
  maxPhysicalFrameBytes?: number;
  now?: () => number;
}

export interface RelayRpcBridge {
  protocol: IMessagePassingProtocol;
  /** 入站帧入口：只接受属于本 bridge 的 rpc-frame / rpc-frame-ack。 */
  handleFrame: (frame: RelayTransportFrame) => void;
  flushPending: () => void;
  /** 对外通告一次桥降级（如传输层物理帧超限），让终端走 recoverConnection。 */
  degrade: (reasonCode: RelayRpcDegradedReasonCode, detail?: string) => void;
  dispose: () => void;
}

export function createRelayRpcBridge(options: RelayRpcBridgeOptions): RelayRpcBridge {
  const { context, sendFrame } = options;
  const now = options.now ?? Date.now;
  const maxPhysicalFrameBytes =
    options.maxPhysicalFrameBytes ?? RELAY_RPC_DEFAULT_MAX_PHYSICAL_FRAME_BYTES;
  const emitter = new Emitter<VSBuffer>();
  const receiver = new RelayRpcFrameReceiver(now);

  let seq = 0;
  let messageSeq = 0;
  let disposed = false;
  const pending: Uint8Array[] = [];

  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  const emitDegraded = (reasonCode: RelayRpcDegradedReasonCode, detail?: string): void => {
    options.onDegraded?.({ reasonCode, detail });
  };

  const write = (bytes: Uint8Array): boolean => {
    const frames = encodeRelayRpcFrames({
      bytes,
      bridgeSessionId: context.bridgeSessionId,
      bridgeGeneration: context.bridgeGeneration,
      recoveryId: context.recoveryId,
      messageSeq: nextMessageSeq(),
      nextSeq,
      maxFragmentBytes: pickFragmentBytes(bytes.byteLength, maxPhysicalFrameBytes, context),
    });
    for (const frame of frames) {
      if (!sendFrame(frame)) {
        // 链路不可用：整条报文回退到待发队列，由 flushPending 重试，避免只发半截分片。
        return false;
      }
    }
    return true;
  };

  const nextMessageSeq = (): number => {
    messageSeq += 1;
    return messageSeq;
  };

  const flushPending = (): void => {
    while (pending.length > 0) {
      const bytes = pending[0];
      if (!bytes) return;
      if (!write(bytes)) return;
      pending.shift();
    }
  };

  const protocol: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      if (disposed) return;
      if (pending.length > 0) {
        pending.push(buffer.buffer);
        if (pending.length > RELAY_RPC_MAX_BUFFERED_MESSAGES) {
          pending.length = 0;
          emitDegraded("buffer-overflow", "待发 RPC 报文超过上限，整批丢弃");
        }
        return;
      }
      if (!write(buffer.buffer)) {
        pending.push(buffer.buffer);
      }
    },
    onMessage: emitter.event as Event<VSBuffer>,
  };

  const handleFrame = (frame: RelayTransportFrame): void => {
    if (disposed) return;
    if (frame.bridgeSessionId !== context.bridgeSessionId) return;

    if (frame.zcode_type === "rpc-frame-ack") {
      return;
    }

    const result = receiver.accept(frame);
    if (result.kind === "fault") {
      if (result.ack) sendFrame(result.ack);
      emitDegraded("rpc-transport-fault", result.reasonCode);
      return;
    }
    sendFrame(result.ack);
    if (result.kind === "message") {
      emitter.fire(VSBuffer.wrap(result.bytes));
    }
  };

  const pruneTimer = setInterval(() => {
    const expired = receiver.pruneExpired();
    if (expired.length > 0) {
      emitDegraded("buffer-timeout", `分片组装超时: ${expired.join(",")}`);
    }
    flushPending();
  }, 10_000);
  pruneTimer.unref?.();

  return {
    protocol,
    handleFrame,
    flushPending,
    /** 供传输层上报外部故障（如物理帧超限），让终端走 recoverConnection 而不是干等。 */
    degrade: (reasonCode: RelayRpcDegradedReasonCode, detail?: string): void =>
      emitDegraded(reasonCode, detail),
    dispose: () => {
      disposed = true;
      clearInterval(pruneTimer);
      pending.length = 0;
      emitter.dispose();
    },
  };
}

/**
 * 选每片字节数，使「含信封的 JSON 帧」不超过 maxPhysicalFrameBytes。
 * 先按均分片数估一次，超预算则二分收敛；分片数上限与终端一致。
 */
export function pickFragmentBytes(
  messageBytes: number,
  maxPhysicalFrameBytes: number,
  context: RelayRpcBridgeContext,
): number {
  const envelopeOverhead = measureEnvelopeBytes(
    messageBytes,
    messageBytes,
    1,
    messageBytes,
    context,
  ).bytes;
  const budget = Math.max(64, maxPhysicalFrameBytes - envelopeOverhead);
  let fragmentBytes = Math.min(messageBytes, budget);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fragmentCount = Math.min(
      RELAY_TRANSPORT_MAX_FRAGMENTS,
      Math.max(1, Math.ceil(messageBytes / fragmentBytes)),
    );
    const measured = measureEnvelopeBytes(
      messageBytes,
      Math.ceil(messageBytes / fragmentCount),
      fragmentCount,
      messageBytes,
      context,
    );
    if (measured.bytes <= maxPhysicalFrameBytes || fragmentBytes <= 64) break;
    fragmentBytes = Math.max(
      64,
      Math.floor(fragmentBytes * (maxPhysicalFrameBytes / measured.bytes)),
    );
  }
  return fragmentBytes;
}

function measureEnvelopeBytes(
  fragmentBytes: number,
  perFragment: number,
  fragmentCount: number,
  messageBytes: number,
  context: RelayRpcBridgeContext,
): { bytes: number } {
  const probe: RelayRpcFrame = {
    zcode_type: "rpc-frame",
    bridgeSessionId: context.bridgeSessionId,
    ...(typeof context.bridgeGeneration === "number"
      ? { bridgeGeneration: context.bridgeGeneration }
      : {}),
    ...(context.recoveryId ? { recoveryId: context.recoveryId } : {}),
    seq: Number.MAX_SAFE_INTEGER,
    messageSeq: Number.MAX_SAFE_INTEGER,
    fragmentIndex: Math.max(0, fragmentCount - 1),
    fragmentCount,
    messageBytes,
    checksum: { algorithm: "crc32", value: "00000000" },
    dataBase64: "A".repeat(4 * Math.ceil(Math.min(fragmentBytes, perFragment) / 3)),
  };
  return { bytes: Buffer.byteLength(JSON.stringify(probe), "utf8") };
}

export { buildRelayRpcFrameAck };
