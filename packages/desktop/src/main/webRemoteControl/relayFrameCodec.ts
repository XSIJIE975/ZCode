import {
  crc32WireBytes,
  encodeWireBytesBase64,
  decodeWireBase64,
} from "@zcode/shared/zcode-protocol-v4";

// relay 传输层（rpc-frame）的分片与重组。
// 与 `zcode-protocol-v4` 的 topic wire 分片是两层不同的东西：这一层承载的是
// `@zcode/rpc` 的整条报文，终端与桌面各自实现同一契约；字段与上限取自终端侧 zod 校验。

export const RELAY_TRANSPORT_MAX_FRAGMENTS = 64;
export const RELAY_TRANSPORT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const RELAY_TRANSPORT_ASSEMBLY_TIMEOUT_MS = 30_000;
export const RELAY_TRANSPORT_ID_MAX_CHARS = 256;

const RELAY_TRANSPORT_ID_PATTERN = /^[A-Za-z0-9._~-]+$/u;

export interface RelayTransportChecksum {
  algorithm: "crc32";
  value: string;
}

export interface RelayRpcFrame {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: RelayTransportChecksum;
  dataBase64: string;
}

export interface RelayRpcFrameAck {
  zcode_type: "rpc-frame-ack";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  ackMessageSeq: number;
}

export type RelayTransportFrame = RelayRpcFrame | RelayRpcFrameAck;

export class RelayTransportFrameError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayTransportFrameError";
  }
}

export function assertRelayTransportId(value: string, label: string): string {
  if (!RELAY_TRANSPORT_ID_PATTERN.test(value) || value.length > RELAY_TRANSPORT_ID_MAX_CHARS) {
    throw new RelayTransportFrameError(
      "proto.transportEnvelopeIdInvalid",
      `${label} 不符合 relay 传输层 id 约束`,
    );
  }
  return value;
}

/**
 * 把一条逻辑报文切成 rpc-frame。
 * 终端约束 `fragmentCount <= messageBytes`，因此空报文不可发送；
 * `maxFragmentBytes` 需给信封 JSON 开销留余量，由调用方按实测帧长决定。
 */
export function encodeRelayRpcFrames(input: {
  bytes: Uint8Array;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  messageSeq: number;
  nextSeq: () => number;
  maxFragmentBytes: number;
}): RelayRpcFrame[] {
  const { bytes, bridgeSessionId, messageSeq, nextSeq } = input;
  if (bytes.byteLength === 0) {
    throw new RelayTransportFrameError("proto.frameEmpty", "relay 传输层不接受空报文");
  }
  if (bytes.byteLength > RELAY_TRANSPORT_MAX_MESSAGE_BYTES) {
    throw new RelayTransportFrameError("proto.messageTooLarge", "逻辑报文超过 16MiB 上限");
  }
  const fragmentCount = Math.min(
    RELAY_TRANSPORT_MAX_FRAGMENTS,
    Math.max(1, Math.ceil(bytes.byteLength / Math.max(1, input.maxFragmentBytes))),
  );
  // 均分而不是按预算硬切，避免最后一片过小；同时保证 fragmentIndex < fragmentCount。
  const perFragment = Math.ceil(bytes.byteLength / fragmentCount);
  const checksum: RelayTransportChecksum = { algorithm: "crc32", value: crc32WireBytes(bytes) };
  const frames: RelayRpcFrame[] = [];
  for (let index = 0; index < fragmentCount; index += 1) {
    const slice = bytes.subarray(
      index * perFragment,
      Math.min(bytes.byteLength, (index + 1) * perFragment),
    );
    frames.push({
      zcode_type: "rpc-frame",
      bridgeSessionId,
      ...optionalNumber("bridgeGeneration", input.bridgeGeneration),
      ...optionalString("recoveryId", input.recoveryId),
      seq: nextSeq(),
      messageSeq,
      fragmentIndex: index,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(slice),
    });
  }
  return frames;
}

export function buildRelayRpcFrameAck(frame: RelayRpcFrame): RelayRpcFrameAck {
  return {
    zcode_type: "rpc-frame-ack",
    bridgeSessionId: frame.bridgeSessionId,
    ...optionalNumber("bridgeGeneration", frame.bridgeGeneration),
    ...optionalString("recoveryId", frame.recoveryId),
    ackMessageSeq: frame.messageSeq,
  };
}

interface PendingAssembly {
  parts: (Uint8Array | undefined)[];
  received: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: string;
  startedAt: number;
}

export type RelayInboundResult =
  | { kind: "ack-only"; ack: RelayRpcFrameAck }
  | { kind: "message"; ack: RelayRpcFrameAck; messageSeq: number; bytes: Uint8Array }
  | { kind: "fault"; ack?: RelayRpcFrameAck; reasonCode: string; message: string };

/**
 * 单条桥的入站状态机：按 messageSeq 聚合分片，齐备后校验 crc32 再交付。
 * seq 只用于诊断 rpc-frame-gap，不参与组帧。
 */
export class RelayRpcFrameReceiver {
  private readonly messages = new Map<number, PendingAssembly>();
  private lastSeq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get gapCount(): number {
    return this.gaps;
  }

  private gaps = 0;

  accept(frame: RelayRpcFrame): RelayInboundResult {
    const malformed = this.validate(frame);
    if (malformed) return malformed;

    if (this.lastSeq && frame.seq > this.lastSeq + 1) this.gaps += 1;
    this.lastSeq = Math.max(this.lastSeq, frame.seq);

    let entry = this.messages.get(frame.messageSeq);
    if (!entry) {
      entry = {
        parts: Array.from({ length: frame.fragmentCount }) as (Uint8Array | undefined)[],
        received: 0,
        fragmentCount: frame.fragmentCount,
        messageBytes: frame.messageBytes,
        checksum: frame.checksum.value,
        startedAt: this.now(),
      };
      this.messages.set(frame.messageSeq, entry);
    }
    if (!entry.parts[frame.fragmentIndex]) {
      const decoded = decodeWireBase64(frame.dataBase64);
      if (!decoded) {
        return {
          kind: "fault",
          reasonCode: "proto.frameAssemblyInvalidPayload",
          message: "dataBase64 解码失败",
        };
      }
      entry.parts[frame.fragmentIndex] = decoded;
      entry.received += 1;
    }

    const ack = buildRelayRpcFrameAck(frame);
    if (entry.received < entry.fragmentCount) return { kind: "ack-only", ack };

    this.messages.delete(frame.messageSeq);
    const bytes = concatBytes(entry.parts.filter((part): part is Uint8Array => Boolean(part)));
    if (bytes.byteLength !== entry.messageBytes) {
      return {
        kind: "fault",
        ack,
        reasonCode: "proto.frameAssemblySizeMismatch",
        message: `重组长度 ${bytes.byteLength} 与 messageBytes ${entry.messageBytes} 不一致`,
      };
    }
    if (crc32WireBytes(bytes) !== entry.checksum) {
      return {
        kind: "fault",
        ack,
        reasonCode: "proto.frameAssemblyChecksumMismatch",
        message: "crc32 校验失败",
      };
    }
    return { kind: "message", ack, messageSeq: frame.messageSeq, bytes };
  }

  /** 超时未收齐的逻辑消息直接丢弃，返回被丢弃的 messageSeq 供上层报 buffer-timeout。 */
  pruneExpired(now = this.now()): number[] {
    const expired: number[] = [];
    for (const [messageSeq, entry] of this.messages) {
      if (now - entry.startedAt > RELAY_TRANSPORT_ASSEMBLY_TIMEOUT_MS) {
        expired.push(messageSeq);
        this.messages.delete(messageSeq);
      }
    }
    return expired;
  }

  private validate(frame: RelayRpcFrame): RelayInboundResult | null {
    const fail = (reasonCode: string, message: string): RelayInboundResult => ({
      kind: "fault",
      reasonCode,
      message,
    });
    if (
      frame.checksum?.algorithm !== "crc32" ||
      !/^[0-9a-f]{8}$/u.test(frame.checksum.value ?? "")
    ) {
      return fail("proto.frameChecksumInvalid", "checksum 字段不合形");
    }
    if (!Number.isInteger(frame.fragmentCount) || frame.fragmentCount <= 0) {
      return fail("proto.frameFragmentCountInvalid", "fragmentCount 必须为正整数");
    }
    if (frame.fragmentCount > RELAY_TRANSPORT_MAX_FRAGMENTS)
      return fail("proto.tooManyFragments", "分片数超上限");
    if (
      !Number.isInteger(frame.fragmentIndex) ||
      frame.fragmentIndex < 0 ||
      frame.fragmentIndex >= frame.fragmentCount
    ) {
      return fail("proto.frameIndexInvalid", "fragmentIndex 越界");
    }
    if (!Number.isInteger(frame.messageBytes) || frame.messageBytes < frame.fragmentCount) {
      return fail("proto.frameMessageBytesInvalid", "messageBytes 小于 fragmentCount");
    }
    if (frame.messageBytes > RELAY_TRANSPORT_MAX_MESSAGE_BYTES)
      return fail("proto.messageTooLarge", "逻辑报文超 16MiB");
    if (!Number.isSafeInteger(frame.seq) || frame.seq <= 0)
      return fail("proto.seqInvalid", "seq 必须为正整数");
    if (!Number.isSafeInteger(frame.messageSeq) || frame.messageSeq <= 0) {
      return fail("proto.messageSeqInvalid", "messageSeq 必须为正整数");
    }
    return null;
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function optionalNumber(key: string, value: number | undefined): Record<string, number> {
  return typeof value === "number" ? { [key]: value } : {};
}

function optionalString(key: string, value: string | undefined): Record<string, string> {
  return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}
