import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  resolveRelayHeartbeatDelay,
  resolveRelayHeartbeatJitterMs,
  resolveRelayReconnectJitterMs,
} from "../src/main/webRemoteControl/relayProtocol.js";
import { createRelayDeviceTransport } from "../src/main/webRemoteControl/relayDeviceTransport.js";
import type {
  RelayAuthMaterial,
  RelayDeviceTransportOptions,
  RelaySocket,
} from "../src/main/webRemoteControl/relayTransportContract.js";

// 传输层时序与配对状态机的回归测试。
// 这些阈值和「保持 paired」的判定只能靠实测才知道对不对，写成测试是为了防止再被改回去。

interface FakeSocket extends RelaySocket {
  emitOpen(): void;
  emitMessage(text: string): void;
  emitClose(code?: number): void;
  sent(): string[];
}

function createFakeSocket(): FakeSocket {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  const out: string[] = [];
  const socket: FakeSocket = {
    readyState: 1,
    send(data: string) {
      out.push(data);
    },
    close() {
      for (const handler of listeners.close ?? []) handler(1006, Buffer.from(""));
    },
    on(event, handler) {
      (listeners[event] ??= []).push(handler);
    },
    emitOpen() {
      for (const handler of listeners.open ?? []) handler();
    },
    emitMessage(text) {
      for (const handler of listeners.message ?? []) handler({ toString: () => text });
    },
    emitClose(code = 1006) {
      for (const handler of listeners.close ?? []) handler(code, Buffer.from(""));
    },
    sent: () => out,
  };
  return socket;
}

function createHarness(
  auth: RelayAuthMaterial = { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
) {
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const options: RelayDeviceTransportOptions = {
    relayWsUrl: "wss://relay.example/ws",
    deviceMid: "mid-1",
    meta: { platform: "win32", version: "3.14.3", name: "TEST-BOX" },
    createSocket: () => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    },
    resolveAuth: () => auth,
    onRegisteredAuth: () => {},
    onClearAuth: () => {},
    onData: () => {},
    onStateChange: (state) => states.push(state),
    logger: { info: () => {}, warn: () => {} },
  };
  return {
    options,
    sockets,
    states,
    get current(): FakeSocket | undefined {
      return sockets.at(-1);
    },
    connectCount: () => sockets.length,
    transport: createRelayDeviceTransport(options),
  };
}

/** 走到 paired 的最小帧序：auth_ack(matched)。持久化凭据下不需要注册帧。 */
function reachPaired(harness: ReturnType<typeof createHarness>): void {
  harness.current.emitOpen();
  harness.current.emitMessage(JSON.stringify({ type: "auth_ack", pair_status: "matched" }));
}

describe("心跳与重连抖动", () => {
  it("抖动是半宽：10s 心跳落在 [8s, 12s]", () => {
    assert.equal(
      resolveRelayHeartbeatDelay(10_000, undefined, () => 0),
      8_000,
    );
    assert.equal(
      resolveRelayHeartbeatDelay(10_000, undefined, () => 0.999_999_999),
      12_000,
    );
    assert.equal(
      resolveRelayHeartbeatDelay(10_000, undefined, () => 0.5),
      10_000,
    );
  });

  it("抖动幅度取周期的 20% 与 2s 的较小值，非正数表示关闭", () => {
    assert.equal(resolveRelayHeartbeatJitterMs(10_000), 2_000);
    assert.equal(resolveRelayHeartbeatJitterMs(5_000), 1_000);
    assert.equal(resolveRelayHeartbeatJitterMs(10_000, 0), 0);
    assert.equal(resolveRelayHeartbeatJitterMs(10_000, -1), 0);
    // 显式覆盖只被「周期 - 1」收敛，不受 2s 上限约束，否则算不出负延时。
    assert.equal(resolveRelayHeartbeatJitterMs(10_000, 30_000), 9_999);
    assert.equal(
      resolveRelayHeartbeatDelay(10_000, 0, () => 0.9),
      10_000,
    );
  });

  it("重连抖动是 [0, jitter]", () => {
    assert.equal(
      resolveRelayReconnectJitterMs(2_000, () => 0),
      0,
    );
    assert.equal(
      resolveRelayReconnectJitterMs(2_000, () => 0.5),
      1_000,
    );
    assert.equal(
      resolveRelayReconnectJitterMs(2_000, () => 0.999_999_999),
      2_000,
    );
    assert.equal(
      resolveRelayReconnectJitterMs(0, () => 0.5),
      0,
    );
  });
});

describe("传输层时序与配对状态机", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("普通断线固定 1s 后重连，不加抖动", () => {
    const harness = createHarness();
    harness.transport.start();
    assert.equal(harness.connectCount(), 1);
    // 先拿到一次 ack：否则这条关闭会被判成「持久化 sid 已失效」，走的是立即重注册那条路。
    reachPaired(harness);
    harness.current.emitClose();

    mock.timers.tick(999);
    assert.equal(harness.connectCount(), 1);
    mock.timers.tick(1);
    assert.equal(harness.connectCount(), 2);
  });

  it("配对后回到 waiting 仍保持 paired，并在第二次 waiting 时立刻重来", () => {
    const harness = createHarness();
    harness.transport.start();
    reachPaired(harness);
    assert.equal(harness.transport.getState(), "paired");

    // 第一次 waiting：只记一次待恢复，状态不掉，也不重连。
    harness.current.emitMessage(
      JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }),
    );
    assert.equal(harness.transport.getState(), "paired");
    assert.equal(harness.connectCount(), 1);

    // 被顶替期间不能出站。
    assert.equal(harness.transport.sendPayload({ zcode_type: "ping" }).kind, "unavailable");

    // 第二次 waiting：立刻换一条链路，不排队等恢复窗。
    harness.current.emitMessage(
      JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }),
    );
    assert.equal(harness.connectCount(), 2);
  });

  it("waiting 恢复窗 15s 到期才重连，期间保持 paired", () => {
    const harness = createHarness();
    harness.transport.start();
    reachPaired(harness);
    harness.current.emitMessage(
      JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }),
    );

    mock.timers.tick(14_999);
    assert.equal(harness.connectCount(), 1);
    mock.timers.tick(1);
    assert.equal(harness.connectCount(), 2);
  });

  it("ack 看门狗是精确 30s 的一次性定时器，收到 ack 会重新武装", () => {
    const harness = createHarness();
    harness.transport.start();
    reachPaired(harness);

    mock.timers.tick(29_999);
    assert.equal(harness.connectCount(), 1);
    // ack 把看门狗推回 30s，而不是让同一个到期点继续走。
    harness.current.emitMessage(
      JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }),
    );
    mock.timers.tick(1);
    assert.equal(harness.connectCount(), 1);
    mock.timers.tick(29_999);
    assert.equal(harness.connectCount(), 1);
    // 到点：这条路径要重连，但重连延时是抖动本身（0–2s），所以要再走完整个抖动窗。
    mock.timers.tick(1);
    mock.timers.tick(2_000);
    assert.equal(harness.connectCount(), 2);
  });

  it("INTERNAL 在会话存活期不重连，只回到等待", () => {
    const harness = createHarness();
    harness.transport.start();
    reachPaired(harness);
    harness.current.emitMessage(
      JSON.stringify({ type: "error", code: "INTERNAL", message: "busy" }),
    );
    assert.equal(harness.connectCount(), 1);
    assert.equal(harness.transport.getState(), "waiting_terminal");
  });

  it("AUTH_FAILED 沿用同一份 passHash 立刻重新注册", () => {
    const cleared: string[] = [];
    const sockets: FakeSocket[] = [];
    // 上层要真的停止把死 sid 交回来：onClearAuth 之后 resolveAuth 必须换成 register 模式，
    // 否则 transport 重连时会再次拿它发 auth_init，回退就等于没发生。
    let persisted = true;
    const auth = (): RelayAuthMaterial =>
      persisted
        ? { mode: "persisted", deviceSid: "sid-dead", passHash: "hash-1" }
        : { mode: "register", passHash: "hash-1" };
    const transport = createRelayDeviceTransport({
      relayWsUrl: "wss://relay.example/ws",
      deviceMid: "mid-1",
      meta: {},
      createSocket: () => {
        const socket = createFakeSocket();
        sockets.push(socket);
        return socket;
      },
      resolveAuth: auth,
      onRegisteredAuth: () => {},
      onClearAuth: (reason) => {
        cleared.push(reason);
        persisted = false;
      },
      onData: () => {},
      logger: { info: () => {}, warn: () => {} },
    });
    transport.start();
    sockets[0].emitOpen();
    sockets[0].emitMessage(JSON.stringify({ type: "error", code: "AUTH_FAILED", message: "nope" }));
    assert.deepEqual(cleared, ["auth-failed"]);
    // 抑制标记吃掉了这次主动关闭的重连，只保留立即重连这一条路径。
    mock.timers.tick(10_000);
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1].readyState, 1);
    sockets[1].emitOpen();
    const register = JSON.parse(sockets[1].sent()[0] ?? "{}");
    assert.equal(register.type, "device_register_init");
    assert.equal(register.pass_hash, "hash-1");
  });

  it("未配对期收到 WRONG_PARAM 是终局：落 error 且不再重连", () => {
    const failures: Array<{ reason: string; message?: string }> = [];
    const sockets: FakeSocket[] = [];
    const transport = createRelayDeviceTransport({
      relayWsUrl: "wss://relay.example/ws",
      deviceMid: "mid-1",
      meta: {},
      createSocket: () => {
        const socket = createFakeSocket();
        sockets.push(socket);
        return socket;
      },
      resolveAuth: () => ({ mode: "register", passHash: "hash-1" }),
      onRegisteredAuth: () => {},
      onClearAuth: () => {},
      onData: () => {},
      onTransportFailure: (failure) => failures.push(failure),
      logger: { info: () => {}, warn: () => {} },
    });
    transport.start();
    sockets[0].emitOpen();
    sockets[0].emitMessage(
      JSON.stringify({ type: "error", code: "WRONG_PARAM", message: "bad meta" }),
    );
    assert.equal(transport.getState(), "error");
    assert.deepEqual(failures, [{ reason: "unexpected-error", message: "bad meta" }]);
    // 终局后必须由用户重新启用才会恢复：中继持续拒机时不能变成每秒一次的注册风暴。
    mock.timers.tick(60_000);
    assert.equal(sockets.length, 1);
    transport.start();
    assert.equal(sockets.length, 2);
  });

  it("stop 之后不再重连", () => {
    const harness = createHarness();
    harness.transport.start();
    reachPaired(harness);
    harness.transport.stop("test");
    mock.timers.tick(60_000);
    assert.equal(harness.connectCount(), 1);
    assert.equal(harness.transport.getState(), "idle");
  });
});
