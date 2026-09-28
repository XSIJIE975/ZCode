// 单槽互踢场景（§6-8）：两台终端先后用同一份配对凭据连中继，观察各自看到什么。
// 判据在设备端日志里（本脚本不读 app 状态）：设备端应记录 KICKED、重连并回到 waiting_terminal，
// 全程不崩、不留下僵尸桥。
//
// 用法: node scripts/dev/web-remote-local-kick.mjs --url=<配对链接>

import { createHmac } from "node:crypto";
import WebSocket from "ws";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const url = new URL(String(args.url ?? ""));
const SID = url.searchParams.get("sid") ?? "";
const PASS_HASH = url.searchParams.get("hash") ?? "";
const MID = url.searchParams.get("mid") ?? "kick-client";
const RELAY = `ws://127.0.0.1:${url.port || 9977}/ws?mid=${encodeURIComponent(MID)}`;
if (!SID || !PASS_HASH) {
  console.log("缺少 --url=<配对链接>");
  process.exit(1);
}

const proof = (nonce, role) =>
  createHmac("sha256", PASS_HASH).update(`${nonce}|${role}|${SID}`).digest("base64url");

/** 连一个终端：`settled` 在它被关闭时报出结果，`matched` 在首次配对成功时报出。 */
function openTerminal(label) {
  const events = [];
  let markMatched;
  const matched = new Promise((resolve) => {
    markMatched = resolve;
  });
  const ws = new WebSocket(RELAY, { perMessageDeflate: false, headers: { "X-Device-ID": MID } });
  const settle = (outcome) => {
    clearTimeout(timer);
    try {
      ws.close();
    } catch {
      // 已关闭。
    }
    resolveSettled({ label, outcome, events });
  };
  let resolveSettled;
  const settled = new Promise((resolve) => {
    resolveSettled = resolve;
  });
  const timer = setTimeout(() => settle("timeout"), 25000);
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "auth_init",
        role: "terminal",
        device_sid: SID,
        meta: { name: `kick-${label}` },
        client_ts: Date.now(),
      }),
    ),
  );
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    events.push(frame.type);
    if (frame.type === "auth_challenge") {
      ws.send(
        JSON.stringify({
          type: "auth_response",
          device_sid: SID,
          proof: proof(frame.nonce, "terminal"),
          client_ts: Date.now(),
        }),
      );
      return;
    }
    if (frame.type === "auth_ack" || frame.type === "pair_status_ack") {
      events.push(`pair_status=${frame.pair_status}`);
      if (frame.pair_status === "matched") markMatched();
      return;
    }
    if (frame.type === "error") {
      events.push(`error=${frame.code}`);
      // KICKED 之类的错误帧不等于这条终端连接结束，先记下来，关闭由对端决定。
    }
  });
  ws.on("close", (code) => settle(`closed:${code}`));
  ws.on("error", (error) => settle(`socket-error:${error.message}`));
  return { matched, settled };
}

// A 必须保持在线，B 的接入才会触发单槽互踢；所以 A 不 await，只等它报 matched。
const a = openTerminal("A");
await a.matched;
console.log("A: matched（保持在线，等待被踢）");
const b = openTerminal("B");
const bResult = await b.settled;
console.log(`B: ${bResult.outcome} | ${bResult.events.join(",")}`);
const aResult = await a.settled;
console.log(`A: ${aResult.outcome} | ${aResult.events.join(",")}`);
process.exit(0);
