// 本地回环中继：实现已还原的外部中继设备端协议子集，仅用于验证，绝不监听外部地址。
// 协议依据 docs/specs/web-remote-control-relay.md §4/§8。
//
// 用法: node scripts/dev/web-remote-local-relay.mjs --port=9977
import { createServer } from "node:http";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9977);
/** 单槽互踢模拟开关（--kick）。默认关闭，避免影响常规回环链路验证。 */
const KICK_MODE = process.argv.includes("--kick");
const HOST = "127.0.0.1";

/** deviceSid -> device 会话；terminalSid 与其配对。 */
const devices = new Map();
const pendingAuth = new Map();

/**
 * proof = base64url(HMAC-SHA256(key=passHash 字符串本身, `${nonce}|${role}|${deviceSid}`))
 * 注意 key 不是 base64 解码后的字节：厂商中继接受设备端这种算法（实测曾到 matched），
 * 本中继按同一口径实现，否则会把正确客户端误判成 proof mismatch。
 */
function proofOf(passHash, nonce, role, deviceSid) {
  return createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url");
}

function send(socket, frame) {
  // 对端可能尚未配对（terminal 为 null），这里必须先挡空，否则读 undefined.readyState 会整进程崩。
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify(frame));
}

/** error 帧后立刻 close 会把帧丢在内核缓冲里，设备端只看到 1005、无法区分死 sid 与网络抖动。 */
function sendThenClose(socket, frame) {
  if (!socket || socket.readyState !== 1) {
    socket?.close();
    return;
  }
  socket.send(JSON.stringify(frame), () => socket.close());
}

function pairStatusOf(device) {
  return device.terminal ? "matched" : "waiting";
}

function attachSocket(socket, query) {
  const state = { role: null, device: null };
  socket.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: "error", code: "WRONG_PARAM", message: "frame is not JSON" });
      return;
    }

    switch (frame.type) {
      case "device_register_init": {
        const deviceSid = `d_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
        const device = {
          deviceSid,
          passHash: String(frame.pass_hash ?? ""),
          deviceMid: String(frame.device_mid ?? query.get("mid") ?? ""),
          meta: frame.meta ?? {},
          socket,
          terminal: null,
        };
        devices.set(deviceSid, device);
        state.role = "device";
        state.device = device;
        send(socket, { type: "device_register_ack", device_sid: deviceSid });
        console.log(
          `[relay] device registered sid=…${deviceSid.slice(-6)} mid=…${device.deviceMid.slice(-6)}`,
        );
        return;
      }
      case "auth_init": {
        const device = devices.get(frame.device_sid);
        if (!device) {
          console.log(
            `[relay] auth_init for unknown sid=…${String(frame.device_sid ?? "").slice(-6)}`,
          );
          sendThenClose(socket, {
            type: "error",
            code: "AUTH_FAILED",
            message: "unknown device_sid",
          });
          return;
        }
        const nonce = randomBytes(16).toString("base64url");
        pendingAuth.set(`${frame.device_sid}:${frame.role}`, { nonce, device });
        state.role = frame.role;
        state.device = device;
        send(socket, { type: "auth_challenge", nonce });
        return;
      }
      case "auth_response": {
        const device = devices.get(frame.device_sid);
        const pending = pendingAuth.get(`${frame.device_sid}:${state.role ?? "device"}`);
        if (!device || !pending) {
          send(socket, { type: "error", code: "AUTH_FAILED", message: "no pending challenge" });
          return;
        }
        const expected = proofOf(
          device.passHash,
          pending.nonce,
          state.role ?? "device",
          frame.device_sid,
        );
        pendingAuth.delete(`${frame.device_sid}:${state.role ?? "device"}`);
        if (expected !== frame.proof) {
          console.log(`[relay] proof mismatch for role=${state.role}`);
          send(socket, { type: "error", code: "AUTH_FAILED", message: "proof mismatch" });
          socket.close();
          return;
        }
        if (state.role === "terminal") {
          // --kick：模拟厂商中继的单槽互踢。第二台终端就位时先通知设备端 KICKED，
          // 设备端应当活下来、重连并回到 waiting_terminal，而不是崩掉或把第一台踢成僵尸。
          if (KICK_MODE && device.terminal && device.terminal.readyState === 1) {
            console.log(
              `[relay] kicking device slot for sid=…${String(frame.device_sid).slice(-6)}`,
            );
            device.terminal.close();
            send(socket, { type: "auth_ack", pair_status: "waiting" });
            send(device.socket, {
              type: "error",
              code: "KICKED",
              message: "terminal slot replaced by another client",
            });
            device.terminal = null;
            return;
          }
          device.terminal = socket;
          socket.deviceRef = device;
        } else {
          device.socket = socket;
        }
        pendingAuth.delete(`${frame.device_sid}:terminal`);
        send(socket, { type: "auth_ack", pair_status: pairStatusOf(device) });
        console.log(
          `[relay] ${state.role} authenticated sid=…${String(frame.device_sid).slice(-6)}`,
        );
        // 配对状态变化要同时告诉两端，终端据此从等待页切到工作区页。
        send(device.socket, { type: "pair_status_ack", pair_status: pairStatusOf(device) });
        send(device.terminal, { type: "pair_status_ack", pair_status: pairStatusOf(device) });
        return;
      }
      case "pair_status_query": {
        const device = devices.get(frame.device_sid);
        if (!device) return;
        // 心跳节奏是设备端传输层的判据之一（抖动应落在周期的 ±20%），这里把它量出来。
        const now = Date.now();
        const intervalMs = device.lastQueryAt ? now - device.lastQueryAt : 0;
        device.lastQueryAt = now;
        console.log(
          `[relay] pair_status_query${intervalMs ? ` interval=${intervalMs}ms` : ""} sid=…${device.deviceSid.slice(-6)}`,
        );
        send(socket, { type: "pair_status_ack", pair_status: pairStatusOf(device) });
        return;
      }
      case "data": {
        const device = state.device ?? socket.deviceRef;
        if (!device) return;
        const target = socket === device.socket ? device.terminal : device.socket;
        send(target, {
          type: "data",
          payload: frame.payload,
          server_ts: Math.floor(Date.now() / 1000),
        });
        return;
      }
      default:
        return;
    }
  });

  socket.on("close", () => {
    const device = state.device ?? socket.deviceRef;
    if (!device) return;
    if (device.socket === socket) {
      // 只清 socket 引用、保留注册：设备端重连后用同一 sid+passHash 重新 auth_init 即可恢复，
      // 与厂商中继一致（持久化鉴权模式的存在就证明它是跨重连保留注册的）。
      device.socket = null;
      try {
        device.terminal?.close();
      } catch {
        // 终端已自行断开。
      }
      device.terminal = null;
      console.log(
        `[relay] device disconnected (registration kept) sid=…${device.deviceSid.slice(-6)}`,
      );
    } else if (device.terminal === socket) {
      device.terminal = null;
      send(device.socket, { type: "pair_status_ack", pair_status: "waiting" });
      console.log(`[relay] terminal detached sid=…${device.deviceSid.slice(-6)}`);
    }
  });
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, devices: devices.size }));
});
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/ws", `http://${HOST}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/ws", `http://${HOST}`);
  attachSocket(ws, url.searchParams);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[relay] listening on ws://${HOST}:${PORT}/ws  (仅回环)`);
  console.log(`[relay] 设备端覆盖变量: ZCODE_WEB_REMOTE_RELAY_ORIGIN=http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    httpServer.close();
    process.exit(0);
  });
}
