// 本地回环终端客户端：扮演手机侧终端，驱动「配对 → bootstrap → 建桥 → RPC 代理」全链路并给出判定。
//
// 用法: node scripts/dev/web-remote-local-terminal.mjs --port=9977 --sid=<deviceSid> --hash=<passHash> --mid=<deviceMid>
// sid/hash/mid 由本地中继日志或 app 状态取得（见 web-remote-local-relay.mjs 输出）。

import { createHmac } from "node:crypto";
import WebSocket from "ws";
import {
  createBridgeState,
  encodeRpcFrameBytes,
  ingestRpcFrame,
} from "./web-remote-relay-bridge.mjs";
import {
  RpcResponseType,
  deserializeRpcMessage,
  serializeRpcMessage,
} from "./web-remote-rpc-serialization.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const PORT = Number(args.port ?? 9977);
// 直接吃配对链接，避免手工转抄 base64 passHash 时把 +/= 抄错（会表现为 proof mismatch）。
const pairing = args.url ? new URL(String(args.url)) : null;
const DEVICE_SID = String(pairing?.searchParams.get("sid") ?? args.sid ?? "");
const PASS_HASH = String(pairing?.searchParams.get("hash") ?? args.hash ?? "");
const DEVICE_MID = String(pairing?.searchParams.get("mid") ?? args.mid ?? "terminal-client");
if (!DEVICE_SID || !PASS_HASH) {
  console.log("缺少 --url=<配对链接>（或 --sid / --hash）");
  process.exit(1);
}

/** 终端侧第一个动作：订阅 broadcast.onMessage（事件订阅不会当场回帧）。 */
const RPC_REQUEST_TYPE_PROMISE = 100;
const RPC_REQUEST_TYPE_EVENT_LISTEN = 102;
const RPC_LIST_TASKS_REQUEST_ID = 7;

// key 是 passHash 字符串本身（与设备端、中继同一口径）；base64 解码字节是错的。
const proof = (nonce, role) =>
  createHmac("sha256", PASS_HASH).update(`${nonce}|${role}|${DEVICE_SID}`).digest("base64url");

const seen = {
  authAck: false,
  pairStatus: null,
  bootstrap: null,
  bridgeReady: false,
  initializeReceived: false,
  responseAfterListen: null,
  platformResponses: {},
  reconnectResponse: null,
  workspaceListUpdated: null,
  workspaceListUpdatedCount: 0,
  /** 每次推送的可排序签名，用来判定去重是否真的生效（重复签名 = 去重失效）。 */
  workspaceListSignatures: [],
  echoedWorkspaceKey: null,
};
const bridgeState = createBridgeState();
let bridgeSessionId = null;
let workspaceKey = null;
let workspacePath = null;
let seq = 0;
let messageSeq = 0;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?mid=${encodeURIComponent(DEVICE_MID)}`, {
  perMessageDeflate: true,
  headers: { "X-Device-ID": DEVICE_MID },
});

const send = (frame) => ws.send(JSON.stringify(frame));
const sendData = (payload) => send({ type: "data", payload, client_ts: Date.now() });

function sendRpcRequest(bytes) {
  seq += 1;
  messageSeq += 1;
  const frames = encodeRpcFrameBytes(Buffer.from(bytes), {
    bridgeSessionId,
    bridgeGeneration: 1,
    seq,
    messageSeq,
  });
  for (const frame of frames) sendData(frame);
}

/**
 * RPC 探测：先按终端真实顺序订阅 broadcast.onMessage，再发一条只读的
 * zcode-task.listTasks 请求。EventListen 按协议不当场回帧，只有 Promise 请求
 * 才有 PromiseSuccess/PromiseError 应答，因此用它作为「终端 → 设备」通不通的判据。
 */
function sendRpcProbes() {
  sendRpcRequest(
    serializeRpcMessage([RPC_REQUEST_TYPE_EVENT_LISTEN, 0, "broadcast", "onMessage"], undefined),
  );
  // ProxyChannel 服务端是 `target.apply(handler, args)`，因此 body 必须是「实参数组」，
  // 直接传对象会让被调方法拿到 undefined（实测报 reading 'workspacePath' of undefined）。
  sendRpcRequest(
    serializeRpcMessage(
      [RPC_REQUEST_TYPE_PROMISE, RPC_LIST_TASKS_REQUEST_ID, "zcode-task", "listTasks"],
      [{ workspacePath, workspaceIdentity: workspacePath }],
    ),
  );
}

/** 控制面探测：platform-request 白名单方法 + workspace-reconnect-request 可用性判定。 */
function sendControlPlaneProbes() {
  sendData({
    zcode_type: "platform-request",
    requestId: "loopback-platform-1",
    method: "listSSHConfigAliases",
  });
  // 手机粘贴长文本时终端会请求把文本落成宿主临时文件，属白名单能力，必须能回。
  sendData({
    zcode_type: "platform-request",
    requestId: "loopback-platform-2",
    method: "createTempTextAttachment",
    args: { text: "loopback relay attachment probe", filename: "loopback.txt" },
  });
  sendData({
    zcode_type: "workspace-reconnect-request",
    requestId: "loopback-reconnect-1",
    workspaceKey,
  });
}

/**
 * 终端侧独立算一份列表签名，用来验证设备端的推送去重：
 * 两次推送若签名完全相同，说明去重失效（推了重复内容）；签名不同则是列表真的变了。
 */
function workspaceListSignature(result) {
  const workspaces = (result?.workspaces ?? [])
    .map((w) =>
      JSON.stringify([
        w.workspaceIdentity || w.workspacePath,
        w.kind,
        w.connectionState ?? "connected",
      ]),
    )
    .sort();
  const tasks = (result?.tasks ?? [])
    .map((t) =>
      JSON.stringify([
        t.workspaceIdentity || t.workspacePath,
        t.taskId,
        t.title,
        t.displayStatus ?? "idle",
        t.unreadAt ?? "",
        Boolean(t.pinned),
        Boolean(t.archived),
      ]),
    )
    .sort();
  return JSON.stringify([workspaces, tasks]);
}

function noteProgress(label) {
  console.log(`[terminal] ${label}`);
}

const timeout = setTimeout(() => finish("观察窗口结束"), 100000);

function finish(reason) {
  clearTimeout(timeout);
  try {
    ws.close();
  } catch {
    // 已关闭。
  }
  const ok =
    seen.authAck &&
    seen.pairStatus === "matched" &&
    seen.bootstrap?.result?.workspaces?.length > 0 &&
    seen.bridgeReady &&
    seen.initializeReceived &&
    Boolean(seen.responseAfterListen) &&
    seen.platformResponses.listSSHConfigAliases?.success === true &&
    seen.platformResponses.createTempTextAttachment?.success === true &&
    seen.reconnectResponse?.success === true &&
    // 视图回显：设备端要把终端上报的 activeWorkspaceKey 原样带回列表里。
    seen.echoedWorkspaceKey === workspaceKey &&
    // 推送去重：不要求只推一次（task 状态真的变了就该推），但两次推送的内容不能重复。
    seen.workspaceListSignatures.length === new Set(seen.workspaceListSignatures).size;
  console.log("\n══════════ 回环验证结论 ══════════");
  console.log(`auth_ack            : ${seen.authAck}`);
  console.log(`pair_status         : ${seen.pairStatus}`);
  console.log(`bootstrap workspaces: ${seen.bootstrap?.result?.workspaces?.length ?? 0}`);
  console.log(`bootstrap tasks     : ${seen.bootstrap?.result?.tasks?.length ?? 0}`);
  console.log(`bridge-ready        : ${seen.bridgeReady}`);
  console.log(`收到设备端 Initialize: ${seen.initializeReceived}`);
  console.log(`EventListen 得到回应 : ${seen.responseAfterListen ?? "无"}`);
  console.log(
    `platform ssh         : ${JSON.stringify(seen.platformResponses.listSSHConfigAliases)?.slice(0, 160) ?? "无"}`,
  );
  console.log(
    `platform attachment  : ${JSON.stringify(seen.platformResponses.createTempTextAttachment)?.slice(0, 200) ?? "无"}`,
  );
  console.log(`reconnect-response   : ${JSON.stringify(seen.reconnectResponse) ?? "无"}`);
  console.log(
    `workspace-list-updated: ${JSON.stringify(seen.workspaceListUpdated?.result ?? seen.workspaceListUpdated)?.slice(0, 150) ?? "无"}`,
  );
  const dup = seen.workspaceListSignatures.length - new Set(seen.workspaceListSignatures).size;
  console.log(`推送次数            : ${seen.workspaceListUpdatedCount}，其中重复内容 ${dup} 次`);
  console.log(`视图回显            : ${seen.echoedWorkspaceKey ?? "无"}`);
  console.log(`终止原因: ${reason}`);
  console.log(
    ok
      ? "判定：建桥、RPC 代理与控制面探测全部成立（终端 → 中继 → 开源桌面 → 窗口 Host）。"
      : "判定：链路未走完，见上面未成立项。",
  );
  console.log("════════════════════════════════");
  process.exit(ok ? 0 : 1);
}

ws.on("open", () => {
  send({
    type: "auth_init",
    role: "terminal",
    device_sid: DEVICE_SID,
    meta: { name: "loopback-terminal" },
    client_ts: Date.now(),
  });
});

ws.on("message", (raw) => {
  const frame = JSON.parse(raw.toString());

  if (frame.type === "auth_challenge") {
    send({
      type: "auth_response",
      device_sid: DEVICE_SID,
      proof: proof(frame.nonce, "terminal"),
      client_ts: Date.now(),
    });
    return;
  }
  if (frame.type === "auth_ack") {
    seen.authAck = true;
    return;
  }
  if (frame.type === "pair_status_ack") {
    seen.pairStatus = frame.pair_status;
    if (frame.pair_status === "matched" && !seen.bootstrap) {
      setTimeout(
        () => sendData({ zcode_type: "bootstrap-request", requestId: "loopback-bootstrap-1" }),
        300,
      );
    }
    return;
  }
  if (frame.type === "error") {
    finish(`中继返回 error: ${frame.code} ${frame.message ?? ""}`.trim());
    return;
  }
  if (frame.type !== "data") return;
  const payload = frame.payload;

  if (payload?.zcode_type === "bootstrap-response") {
    seen.bootstrap = payload;
    const workspace = payload.result?.workspaces?.[0];
    if (!workspace) {
      finish("bootstrap-response 里没有可用 workspace");
      return;
    }
    bridgeSessionId = `loopback-bridge-${Date.now()}`;
    workspaceKey = (workspace.workspaceIdentity || workspace.workspacePath).trim();
    workspacePath = workspace.workspacePath;
    sendData({
      zcode_type: "workspace-bridge-open",
      requestId: "loopback-bridge-1",
      bridgeSessionId,
      bridgeGeneration: 1,
      workspaceKey,
    });
    return;
  }
  if (payload?.zcode_type === "workspace-bridge-ready") {
    seen.bridgeReady = true;
    // 上报"手机正在看哪个 workspace/task"，设备端要存下来并在后续列表里回显。
    sendData({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        activeTaskId: "loopback-view-task",
        updatedAt: Date.now(),
      },
      deviceInfo: {
        // 与发行版终端的 deviceInfo 同形：browserPlatform 取 navigator.platform，
        // 桌面浏览器打开配对链接时这里就是 Win32，设备端胶囊应显示它而不是「手机」。
        platform: "mobile-browser",
        version: "test",
        name: "Loopback-Terminal",
        browserPlatform: process.platform === "win32" ? "Win32" : process.platform,
      },
    });
    return;
  }
  if (payload?.zcode_type === "workspace-bridge-error") {
    finish(`设备端拒绝建桥: ${payload.reason} ${payload.error ?? ""}`.trim());
    return;
  }
  if (payload?.zcode_type === "platform-response") {
    seen.platformResponses[String(payload.method ?? "")] = payload;
    noteProgress(`platform-response ${payload.method} success=${payload.success}`);
    return;
  }
  if (payload?.zcode_type === "workspace-list-updated") {
    seen.workspaceListUpdatedCount += 1;
    seen.workspaceListSignatures.push(workspaceListSignature(payload.result));
    seen.workspaceListUpdated ??= payload;
    if (payload.result?.activeWorkspaceKey === workspaceKey)
      seen.echoedWorkspaceKey = payload.result.activeWorkspaceKey;
    noteProgress(
      `workspace-list-updated #${seen.workspaceListUpdatedCount} activeWorkspaceKey=${payload.result?.activeWorkspaceKey}`,
    );
    return;
  }
  if (payload?.zcode_type === "workspace-reconnect-response") {
    seen.reconnectResponse = payload;
    noteProgress(`reconnect-response success=${payload.success}`);
    return;
  }
  if (payload?.zcode_type === "bridge-degraded") {
    console.log(`[terminal] bridge-degraded: ${payload.reason}`);
    return;
  }
  if (payload?.zcode_type === "rpc-frame") {
    const { ack, message, invalid } = ingestRpcFrame(bridgeState, payload);
    if (invalid) {
      console.log(`[terminal] rpc-frame 不合形: ${invalid}`);
      return;
    }
    sendData(ack);
    if (!message) return;
    if (!message.checksumOk) {
      console.log("[terminal] rpc-frame crc32 校验失败，丢弃");
      return;
    }
    let decoded;
    try {
      decoded = deserializeRpcMessage(message.bytes);
    } catch (error) {
      console.log(`[terminal] RPC 报文解析失败: ${error.message}`);
      return;
    }
    const [type, id] = decoded.header ?? [];
    if (type === RpcResponseType.Initialize) {
      seen.initializeReceived = true;
      console.log(`[terminal] 收到 Initialize（${message.bytes.byteLength}B, crc32 OK）`);
      setTimeout(() => {
        sendRpcProbes();
        sendControlPlaneProbes();
      }, 200);
      return;
    }
    if (type === RpcResponseType.PromiseSuccess) {
      const body = decoded.body;
      seen.responseAfterListen = `PromiseSuccess id=${id} 任务数=${Array.isArray(body) ? body.length : typeof body}`;
      console.log(`[terminal] ${seen.responseAfterListen}`);
      return;
    }
    if (type === RpcResponseType.PromiseError || type === RpcResponseType.PromiseErrorObj) {
      // 报错也是「终端 → 设备 → 终端」走通的证据，只是方法层失败。
      seen.responseAfterListen = `PromiseError id=${id} ${JSON.stringify(decoded.body)?.slice(0, 160)}`;
      console.log(`[terminal] ${seen.responseAfterListen}`);
      return;
    }
    if (type === RpcResponseType.EventFire) {
      console.log(`[terminal] EventFire id=${id}（broadcast 事件已送达）`);
      return;
    }
    console.log(`[terminal] 未识别的应答 type=${type} id=${id}`);
  }
});

ws.on("error", (error) => finish(`socket error: ${error.message}`));
