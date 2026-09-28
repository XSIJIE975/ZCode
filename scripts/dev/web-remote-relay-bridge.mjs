// Web 远控 bridge 侧逻辑：workspace-bridge-ready 应答 + relay 传输层分片组帧 + ack。
//
// 帧契约（终端 zod schema，.strict()）：
//   rpc-frame     {zcode_type, bridgeSessionId, bridgeGeneration?, recoveryId?, seq, messageSeq,
//                  fragmentIndex, fragmentCount, messageBytes, checksum:{algorithm:"crc32",value:/^[0-9a-f]{8}$/}, dataBase64}
//   rpc-frame-ack {zcode_type, bridgeSessionId, bridgeGeneration?, recoveryId?, ackMessageSeq}
// 约束：fragmentIndex < fragmentCount ≤ maxFragments(64)，fragmentCount ≤ messageBytes，
//       messageBytes ≤ 16MiB，单帧字节 ≤ PROTOCOL_V4_LIMITS.maxFrameBytes。

const MAX_FRAGMENTS = 64;

/**
 * `@zcode/rpc` 的 ChannelServer 在建立时会主动发一帧 Initialize（`send([ResponseType.Initialize])`，
 * 200 = ResponseType.Initialize）。ChannelClient 在收到它之前把所有请求排队，
 * 所以 bridge 建好后设备端必须先把这帧推给终端，否则终端永远停在「同步工作区」。
 * 字节由仓库自身编码器生成：serialize(writer,[200]) + serialize(writer,undefined)
 *   = 04 01 06 c8 01 00（Array(1) → Int(200) → Undefined body）
 */
export const RPC_INITIALIZE_FRAME_BASE64 = "BAEGyAEA";
const ASSEMBLY_TIMEOUT_MS = 30_000;
const CRC32_POLY = 0xedb88320;

/**
 * 控制面桩数据。字段以终端前端自带的 zod schema 为准（终端会校验并静默丢弃不合形的 payload）：
 *   workspace = {workspacePath, workspaceIdentity?, remoteSessionId?, label, workspacePurpose?, kind, connectionState?, lastConnectionError?}
 *   task      = {taskId, title, workspacePath, workspaceIdentity?, remoteSessionId?, workspaceLabel, workspaceKind, createdAt, updatedAt, provider?, unreadAt?, displayStatus?, pinned?, archived?}
 *   bootstrap result = {windowControlSessionId, workspaces, tasks, initialViewState?, mobileViewState?}
 * workspaceKey 不随线传输，由终端按 workspaceIdentity?.trim() || workspacePath 自行推导。
 */
function stubWorkspace(stubWorkspacePath) {
  return {
    workspacePath: stubWorkspacePath,
    workspaceIdentity: stubWorkspacePath,
    label:
      stubWorkspacePath
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() ?? "probe",
    workspacePurpose: "project",
    kind: "local",
    connectionState: "connected",
  };
}

function stubTask(workspace) {
  const now = Date.now();
  return {
    taskId: "probe-task-00000001",
    title: "Probe 占位任务",
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
    workspaceLabel: workspace.label,
    workspaceKind: workspace.kind,
    createdAt: now,
    updatedAt: now,
    displayStatus: "idle",
    pinned: false,
    archived: false,
  };
}

function stubBootstrapResult(deviceSid, workspace, task) {
  return {
    windowControlSessionId: deviceSid,
    workspaces: [workspace],
    tasks: [task],
  };
}

function stubWorkspaceListResult(workspace, task) {
  return {
    workspaces: [workspace],
    tasks: [task],
    activeWorkspaceKey: workspace.workspaceIdentity?.trim() || workspace.workspacePath,
    activeTaskId: task.taskId,
  };
}

export function crc32Hex(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? CRC32_POLY : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/** bridge 状态：每个 bridgeSessionId 维护按 messageSeq 聚合的分片表。 */
export function createBridgeState() {
  return {
    bridges: new Map(),
    openedAt: new Map(),
  };
}

function validateFrame(frame) {
  if (typeof frame?.bridgeSessionId !== "string" || !frame.bridgeSessionId)
    return "missing bridgeSessionId";
  if (!Number.isSafeInteger(frame.seq) || frame.seq <= 0) return "bad seq";
  if (!Number.isSafeInteger(frame.messageSeq) || frame.messageSeq <= 0) return "bad messageSeq";
  if (!Number.isSafeInteger(frame.fragmentCount) || frame.fragmentCount <= 0)
    return "bad fragmentCount";
  if (frame.fragmentCount > MAX_FRAGMENTS) return "fragmentCount over 64";
  if (!Number.isSafeInteger(frame.fragmentIndex) || frame.fragmentIndex < 0)
    return "bad fragmentIndex";
  if (frame.fragmentIndex >= frame.fragmentCount) return "fragmentIndex >= fragmentCount";
  if (!Number.isSafeInteger(frame.messageBytes) || frame.messageBytes <= 0)
    return "bad messageBytes";
  if (frame.fragmentCount > frame.messageBytes) return "fragmentCount > messageBytes";
  if (frame.checksum?.algorithm !== "crc32" || !/^[0-9a-f]{8}$/.test(frame.checksum.value ?? ""))
    return "bad checksum";
  if (typeof frame.dataBase64 !== "string" || frame.dataBase64.length < 4) return "bad dataBase64";
  return null;
}

/**
 * 收一个 rpc-frame：入站缓冲，返回 {ack, message?}。message 仅在该逻辑消息分片齐备且 crc32 相符时给出。
 */
export function ingestRpcFrame(state, frame, now = Date.now()) {
  const invalid = validateFrame(frame);
  if (invalid) return { ack: false, invalid };

  let bridge = state.bridges.get(frame.bridgeSessionId);
  if (!bridge) {
    bridge = { messages: new Map(), lastSeq: 0, gaps: 0 };
    state.bridges.set(frame.bridgeSessionId, bridge);
  }

  // seq 连续性只用于诊断 rpc-frame-gap，不参与组帧。
  if (bridge.lastSeq && frame.seq > bridge.lastSeq + 1) bridge.gaps += 1;
  bridge.lastSeq = Math.max(bridge.lastSeq, frame.seq);

  let entry = bridge.messages.get(frame.messageSeq);
  if (!entry) {
    entry = {
      parts: Array.from({ length: frame.fragmentCount }),
      received: 0,
      expected: frame.fragmentCount,
      bytes: frame.messageBytes,
      checksum: frame.checksum.value,
      startedAt: now,
    };
    bridge.messages.set(frame.messageSeq, entry);
  }
  if (!entry.parts[frame.fragmentIndex]) {
    entry.parts[frame.fragmentIndex] = Buffer.from(frame.dataBase64, "base64");
    entry.received += 1;
  }

  const ack = {
    zcode_type: "rpc-frame-ack",
    bridgeSessionId: frame.bridgeSessionId,
    ...numOrOmit("bridgeGeneration", frame.bridgeGeneration),
    ...strOrOmit("recoveryId", frame.recoveryId),
    ackMessageSeq: frame.messageSeq,
  };

  if (entry.received < entry.expected) return { ack, message: null };

  const joined = Buffer.concat(entry.parts.filter(Boolean));
  bridge.messages.delete(frame.messageSeq);
  const actual = crc32Hex(new Uint8Array(joined));
  return {
    ack,
    message: {
      bytes: joined,
      text: joined.toString("utf8"),
      crc32: actual,
      checksumOk: actual === entry.checksum,
      messageSeq: frame.messageSeq,
      fragmentCount: frame.fragmentCount,
    },
  };
}

function numOrOmit(key, value) {
  return typeof value === "number" ? { [key]: value } : {};
}

function strOrOmit(key, value) {
  return typeof value === "string" && value ? { [key]: value } : {};
}

/** 组 bridge 描述符并产出 workspace-bridge-ready 载荷。 */
export function buildBridgeReadyPayload(frame, workspacePath) {
  const bridge = {
    bridgeSessionId: frame.bridgeSessionId,
    ...numOrOmit("bridgeGeneration", frame.bridgeGeneration),
    ...strOrOmit("recoveryId", frame.recoveryId),
    kind: "local",
    workspaceKey: frame.workspaceKey,
    workspacePath,
    ...strOrOmit("initialTaskId", frame.taskId),
  };
  return {
    zcode_type: "workspace-bridge-ready",
    requestId: frame.requestId,
    bridgeSessionId: frame.bridgeSessionId,
    ...numOrOmit("bridgeGeneration", frame.bridgeGeneration),
    ...strOrOmit("recoveryId", frame.recoveryId),
    bridge,
  };
}

/** 单帧发送一个完整逻辑消息（探针阶段消息都很小，不做多片）。 */
export function encodeRpcFrameBytes(bytes, context) {
  const buf = Buffer.from(bytes);
  return [
    {
      zcode_type: "rpc-frame",
      bridgeSessionId: context.bridgeSessionId,
      ...numOrOmit("bridgeGeneration", context.bridgeGeneration),
      ...strOrOmit("recoveryId", context.recoveryId),
      seq: context.seq,
      messageSeq: context.messageSeq,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: buf.byteLength,
      checksum: { algorithm: "crc32", value: crc32Hex(new Uint8Array(buf)) },
      dataBase64: buf.toString("base64"),
    },
  ];
}

/** 把一段逻辑帧按 rpc-frame 分片发出去（探针回应用；单帧即可时只发 1 片）。 */
export function encodeRpcFrames(text, context) {
  const bytes = Buffer.from(text, "utf8");
  const checksum = { algorithm: "crc32", value: crc32Hex(new Uint8Array(bytes)) };
  const chunkSize = Math.max(1, Math.floor(bytes.byteLength / 1));
  const fragmentCount = Math.min(
    MAX_FRAGMENTS,
    Math.max(1, Math.ceil(bytes.byteLength / chunkSize)),
  );
  const perFragment = Math.ceil(bytes.byteLength / fragmentCount);
  const frames = [];
  for (let index = 0; index < fragmentCount; index += 1) {
    const slice = bytes.subarray(
      index * perFragment,
      Math.min(bytes.byteLength, (index + 1) * perFragment),
    );
    frames.push({
      zcode_type: "rpc-frame",
      bridgeSessionId: context.bridgeSessionId,
      ...numOrOmit("bridgeGeneration", context.bridgeGeneration),
      ...strOrOmit("recoveryId", context.recoveryId),
      seq: context.nextSeq(),
      messageSeq: context.messageSeq,
      fragmentIndex: index,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      dataBase64: slice.toString("base64"),
    });
  }
  return frames;
}

export function pruneStaleAssemblies(state, now = Date.now()) {
  const dropped = [];
  for (const [bridgeSessionId, bridge] of state.bridges) {
    for (const [messageSeq, entry] of bridge.messages) {
      if (now - entry.startedAt > ASSEMBLY_TIMEOUT_MS) {
        bridge.messages.delete(messageSeq);
        dropped.push({
          bridgeSessionId,
          messageSeq,
          received: entry.received,
          expected: entry.expected,
        });
      }
    }
  }
  return dropped;
}

/** 控制面路由：按终端 zod union 应答；不合形的 payload 会被终端静默丢弃。 */
export function routeControlPlanePayload(ctx) {
  const { payload, reply, send, deviceSid, stubWorkspacePath, bridgeState, logger, result } = ctx;
  const stubWs = stubWorkspace(stubWorkspacePath);
  const stubTk = stubTask(stubWs);
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
  pruneStaleAssemblies(bridgeState);
  // reply / send 由调用方注入，避免两处各自实现信封封装。

  if (payload?.zcode_type === "bootstrap-request") {
    reply({
      zcode_type: "bootstrap-response",
      requestId,
      success: true,
      result: stubBootstrapResult(deviceSid, stubWs, stubTk),
    });
    result.answeredTypes.push("bootstrap-response");
  } else if (payload?.zcode_type === "workspace-list-request") {
    reply({
      zcode_type: "workspace-list-response",
      requestId,
      success: true,
      result: stubWorkspaceListResult(stubWs, stubTk),
    });
    result.answeredTypes.push("workspace-list-response");
  } else if (payload?.zcode_type === "platform-request") {
    reply({
      zcode_type: "platform-response",
      requestId,
      method: payload.method,
      success: false,
      error: "probe: platform handler not implemented",
    });
    result.answeredTypes.push(`platform-response:${payload.method}`);
  } else if (payload?.zcode_type === "workspace-bridge-open") {
    result.sawBridgeOpen = true;
    const ready = buildBridgeReadyPayload(payload, stubWorkspacePath);
    bridgeState.openedAt.set(payload.bridgeSessionId, Date.now());
    reply(ready);
    result.answeredTypes.push("workspace-bridge-ready");
    // bridge 建立即推 Initialize，解锁终端排队的 RPC 请求。
    let entry = bridgeState.bridges.get(payload.bridgeSessionId);
    if (!entry) {
      entry = { messages: new Map(), lastSeq: 0, gaps: 0, seq: 0, messageSeq: 0 };
      bridgeState.bridges.set(payload.bridgeSessionId, entry);
    }
    entry.seq += 1;
    entry.messageSeq += 1;
    const initFrames = encodeRpcFrameBytes(Buffer.from(RPC_INITIALIZE_FRAME_BASE64, "base64"), {
      bridgeSessionId: payload.bridgeSessionId,
      bridgeGeneration: payload.bridgeGeneration,
      recoveryId: payload.recoveryId,
      seq: entry.seq,
      messageSeq: entry.messageSeq,
    });
    for (const frame of initFrames) {
      send({ type: "data", payload: frame, client_ts: Date.now() });
    }
    result.sentInitialize = true;
    logger.info("已回 workspace-bridge-ready（local bridge 桩）", {
      bridgeSessionId: payload.bridgeSessionId,
      workspaceKey: payload.workspaceKey,
    });
  } else if (payload?.zcode_type === "rpc-frame") {
    result.sawRpcFrame = true;
    const { ack, message, invalid } = ingestRpcFrame(bridgeState, payload);
    if (invalid) {
      logger.info("rpc-frame 不合形", { reason: invalid, messageSeq: payload.messageSeq });
      return undefined;
    }
    send({ type: "data", payload: ack, client_ts: Date.now() });
    if (message) {
      result.assembledMessages.push(message);
      logger.info("组帧完成", {
        messageSeq: message.messageSeq,
        bytes: message.bytes.byteLength,
        fragments: message.fragmentCount,
        crc32: message.crc32,
        checksumOk: message.checksumOk,
      });
      console.log(`${STATE_LOG_PREFIX} 首帧内容（截断 600）: ${message.text.slice(0, 600)}`);
    }
  } else if (payload?.zcode_type === "rpc-frame-ack") {
    result.sawRpcAck = true;
    logger.info("终端回传 rpc-frame-ack", { ackMessageSeq: payload.ackMessageSeq });
  }

  return undefined;
}
