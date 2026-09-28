import type { WebRemoteControlFailureReason } from "@zcode/shared";
import {
  DEFAULT_RELAY_RECONNECT_DELAY_MS,
  RELAY_MAX_FRAME_BYTES,
  buildExternalRelayWsHeaders,
  buildExternalRelayWsUrl,
  calculateExternalRelayProof,
  describeExternalRelayAuthForLog,
  resolveRelayReconnectJitterMs,
  type ExternalRelayDeviceState,
} from "./relayProtocol.js";
import {
  applyRelayErrorAction,
  parseRelayInboundFrame,
  resolveRelayErrorAction,
} from "./relayInboundFrames.js";
import {
  RELAY_SOCKET_OPEN,
  RELAY_STALE_WAITING_RECOVERY_DELAY_MS,
  type RelayAuthMaterial,
  type RelayDeviceTransport,
  type RelayDeviceTransportOptions,
  type RelaySocket,
} from "./relayTransportContract.js";
import { createRelayPendingOutbound, relayPhysicalFrameBytes } from "./relayPendingOutbound.js";
import { createRelayHeartbeat } from "./relayHeartbeat.js";

// 外部中继设备端传输层：桌面主动外连 relay，完成注册/鉴权/配对观察，并承载 app payload。
// 帧序列、阈值与失败语义按 docs/specs/web-remote-control-relay.md §4/§5 实现。

export function createRelayDeviceTransport(
  options: RelayDeviceTransportOptions,
): RelayDeviceTransport {
  // 晚绑定而不是缓存 Date.now：计时相关的回归测试要能替换时钟。
  const now = (): number => Date.now();

  let state: ExternalRelayDeviceState = "idle";
  let socket: RelaySocket | undefined;
  let deviceSid: string | undefined;
  let auth: RelayAuthMaterial | undefined;
  let manuallyClosed = false;
  /** 终局错误：置位后 close 不再触发重连，必须由用户重新启用才会恢复。 */
  let terminalClose = false;
  let connectAttempt = 0;
  let wasPaired = false;
  /** 配对之后连续收到 waiting 的次数：>0 表示对端已被顶替，此时不允许出站。 */
  let staleWaitingCount = 0;
  let invalidPersistedRetryUsed = false;
  // 本次连接是否已经拿到过 relay 的鉴权/配对回执。持久化凭据对应的 sid 可能已在服务端
  // 过期，此时 relay 不回 error 帧而是直接断链；没有这个标记就无法区分「网络抖动」与
  // 「sid 已失效」，会拿同一个死 sid 无限重连。
  let handshakeConfirmed = false;
  /** 主动关链路以换取「立刻按新凭据重连」时，抑制这一次 close 的自动重连。 */
  let suppressNextCloseReconnect = false;

  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let staleWaitingRecoveryTimer: ReturnType<typeof setTimeout> | undefined;

  const setState = (next: ExternalRelayDeviceState): void => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  // 一次成功握手说明当前凭据是好的，重新给「持久化 sid 失效只回退一次」的额度，
  // 否则本进程后续再遇到 sid 过期就没有自愈能力了。
  const markHandshakeConfirmed = (): void => {
    handshakeConfirmed = true;
    invalidPersistedRetryUsed = false;
  };

  const rawSend = (frame: Record<string, unknown>): boolean => {
    if (!socket || socket.readyState !== RELAY_SOCKET_OPEN) return false;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, "utf8") > RELAY_MAX_FRAME_BYTES) {
      options.logger.warn("[web-remote-control] outbound relay message exceeds hard limit", {
        type: frame.type,
        bytes: Buffer.byteLength(text, "utf8"),
        maxBytes: RELAY_MAX_FRAME_BYTES,
      });
      return false;
    }
    socket.send(text);
    return true;
  };

  const sendAuthInit = (sid: string): void => {
    deviceSid = sid;
    setState("authenticating");
    rawSend({
      type: "auth_init",
      role: "device",
      device_sid: sid,
      meta: options.meta,
      client_ts: now(),
    });
  };

  const clearReconnectTimer = (): void => {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  const clearStaleWaitingRecovery = (): void => {
    clearTimeout(staleWaitingRecoveryTimer);
    staleWaitingRecoveryTimer = undefined;
  };

  const scheduleReconnect = (delayMs: number = DEFAULT_RELAY_RECONNECT_DELAY_MS): void => {
    if (manuallyClosed || terminalClose) return;
    clearReconnectTimer();
    reconnectTimer = setTimeout(connect, delayMs);
    reconnectTimer.unref?.();
  };

  /**
   * 放弃当前链路重来。延时为 0 时同步 connect；有延时时先把状态切成 connecting，
   * 让 UI 立刻反映"正在重连"。socket 先摘走再 close，使旧链路的回调不再影响新状态。
   */
  const reconnectAfterStaleWaiting = (delayMs = 0): void => {
    clearStaleWaitingRecovery();
    heartbeat.stop();
    clearReconnectTimer();
    staleWaitingCount = 0;
    wasPaired = false;
    const dying = socket;
    socket = undefined;
    if (delayMs > 0) setState("connecting");
    dying?.close();
    if (delayMs <= 0) {
      connect();
      return;
    }
    reconnectTimer = setTimeout(connect, delayMs);
    reconnectTimer.unref?.();
  };

  const pendingOutbound = createRelayPendingOutbound({
    now,
    isPaired: () => state === "paired" && staleWaitingCount === 0,
    sendFrame: (payload) => rawSend({ type: "data", payload, client_ts: now() }),
    logger: options.logger,
  });

  const heartbeat = createRelayHeartbeat({
    now,
    isAlive: () => state === "paired" || state === "waiting_terminal",
    canQuery: () => Boolean(deviceSid),
    query: () => {
      if (deviceSid)
        rawSend({ type: "pair_status_query", device_sid: deviceSid, client_ts: now() });
    },
    logger: options.logger,
    onAckTimeout: () => reconnectAfterStaleWaiting(resolveRelayReconnectJitterMs()),
  });

  /** 配对后又被回 waiting：第一次给恢复窗，第二次直接重来；全程保持 paired 状态。 */
  const handleStaleWaiting = (): void => {
    staleWaitingCount += 1;
    heartbeat.start();
    if (staleWaitingCount === 1) {
      if (!staleWaitingRecoveryTimer) {
        staleWaitingRecoveryTimer = setTimeout(() => {
          staleWaitingRecoveryTimer = undefined;
          if (state === "paired" && staleWaitingCount > 0) reconnectAfterStaleWaiting();
        }, RELAY_STALE_WAITING_RECOVERY_DELAY_MS);
        staleWaitingRecoveryTimer.unref?.();
      }
      return;
    }
    reconnectAfterStaleWaiting();
  };

  const applyPairStatus = (status: string | undefined): void => {
    heartbeat.rearm();
    if (status === "waiting") {
      if (wasPaired) {
        handleStaleWaiting();
        return;
      }
      setState("waiting_terminal");
      heartbeat.start();
      return;
    }
    if (status === "matched") {
      staleWaitingCount = 0;
      clearStaleWaitingRecovery();
      setState("paired");
      wasPaired = true;
      heartbeat.start();
      pendingOutbound.flush();
      return;
    }
    // 只认 waiting / matched：未知取值保持原状态。发行版的 applyPairStatus 就是这样，
    // 兜底改成 waiting_terminal 会让一条畸形 ack 把正在工作的 paired 会话降级，
    // 连带清掉设备信息、停掉列表推送。
  };

  /** 中继在会话存活期报错：只是"暂时配不上对"，链路留着继续心跳。 */
  const enterWaitingForPairAfterRelayError = (message?: string): void => {
    options.logger.warn("[web-remote-control] relay error while session alive, waiting", {
      message,
    });
    clearStaleWaitingRecovery();
    staleWaitingCount = 0;
    wasPaired = false;
    setState("waiting_terminal");
    heartbeat.start();
  };

  /** 可恢复错误：状态切 error 让 UI 反映断链，但保留 close → 重连这条自愈路径，不上抛终局原因。 */
  const enterRecoverableError = (message?: string): void => {
    if (state === "error") return;
    options.logger.warn("[web-remote-control] relay error before pairing; recovering", { message });
    heartbeat.stop();
    clearStaleWaitingRecovery();
    setState("error");
    socket?.close();
  };

  /** 终局失败：先立"不再重连"的牌子，再关链路，最后把原因上抛给状态面。 */
  const enterTerminalError = (reason: WebRemoteControlFailureReason, message?: string): void => {
    if (state === "error") return;
    terminalClose = true;
    heartbeat.stop();
    clearStaleWaitingRecovery();
    reportFailure(reason, message);
    setState("error");
    const dying = socket;
    socket = undefined;
    // 链路已经坏了，close 抛错也不影响终局判定；摘走 socket 让 start() 仍能重来。
    try {
      dying?.close();
    } catch {
      // 已断。
    }
  };

  const reportFailure = (reason: WebRemoteControlFailureReason, message?: string): void => {
    options.logger.warn("[web-remote-control] external relay device failed", { reason, message });
    options.onTransportFailure?.({ reason, message });
  };

  /**
   * 沿用同一份 passHash 重新注册：服务端只是不认旧 sid，凭据本身没问题。
   * 先立抑制标记再关链路，避免这次主动关闭被 close 回调再排一次重连。
   */
  const retryWithRegisterAuth = (reason: string): void => {
    invalidPersistedRetryUsed = true;
    if (auth) auth = { mode: "register", passHash: auth.passHash };
    options.onClearAuth(reason);
    deviceSid = undefined;
    suppressNextCloseReconnect = true;
    socket?.close();
    scheduleReconnect(0);
  };

  const errorEffects = {
    onKicked: (message?: string) => {
      options.logger.warn("[web-remote-control] relay kicked current terminal slot", { message });
      socket?.close();
    },
    onReRegisterWithSamePassHash: () => retryWithRegisterAuth("auth-failed"),
    onWaitAfterRelayError: (message?: string) => enterWaitingForPairAfterRelayError(message),
    onRecoverableError: (message?: string) => enterRecoverableError(message),
    onErrorOnly: (message?: string) => {
      options.onTransportFailure?.({ reason: "unexpected-error", message });
    },
    onTerminalError: (reason: WebRemoteControlFailureReason, message?: string) =>
      enterTerminalError(reason, message),
  };

  const handleMessage = (frame: ReturnType<typeof parseRelayInboundFrame>): void => {
    switch (frame.kind) {
      case "registerAck":
        handshakeConfirmed = true;
        deviceSid = frame.deviceSid;
        if (auth?.mode === "register") {
          options.onRegisteredAuth({ deviceSid: frame.deviceSid, passHash: auth.passHash });
          auth = { mode: "persisted", deviceSid: frame.deviceSid, passHash: auth.passHash };
        }
        sendAuthInit(frame.deviceSid);
        return;
      case "authChallenge":
        if (!deviceSid || !auth) {
          enterTerminalError("unexpected-error", "auth challenge arrived before device_sid");
          return;
        }
        rawSend({
          type: "auth_response",
          device_sid: deviceSid,
          proof: calculateExternalRelayProof({
            passHash: auth.passHash,
            nonce: frame.nonce,
            role: "device",
            deviceSid,
          }),
          client_ts: now(),
        });
        return;
      case "pairStatus":
        // 只在鉴权真正通过后续额度：register_ack 就续会让「注册成功→鉴权失败→清凭据→再注册」
        // 变成无限循环。
        markHandshakeConfirmed();
        applyPairStatus(frame.pairStatus);
        return;
      case "data":
        options.onData(frame.payload);
        return;
      case "relayError":
        applyRelayErrorAction(
          resolveRelayErrorAction({
            code: frame.code,
            message: frame.message,
            state,
            auth,
            invalidPersistedRetryUsed,
          }),
          errorEffects,
        );
        return;
      case "ignored":
        return;
    }
  };

  const connect = (): void => {
    clearReconnectTimer();
    heartbeat.stop();
    clearStaleWaitingRecovery();
    connectAttempt += 1;
    handshakeConfirmed = false;
    auth = options.resolveAuth();
    // connect() 只可能由显式 start() 或 scheduleReconnect() 进入，而后者在 terminalClose
    // 期间被抑制，所以终局判定只在 start() 里清零。
    setState("connecting");
    options.logger.info("[web-remote-control] external relay device connecting", {
      attempt: connectAttempt,
      ...describeExternalRelayAuthForLog({ deviceSid: auth.deviceSid, passHash: auth.passHash }),
    });

    const url = buildExternalRelayWsUrl(options.relayWsUrl, options.deviceMid);
    const next = options.createSocket(url, {
      perMessageDeflate: true,
      headers: buildExternalRelayWsHeaders(options.deviceMid),
    });
    socket = next;

    next.on("open", () => {
      if (socket !== next) return;
      if (auth?.mode === "register") {
        setState("registering");
        rawSend({
          type: "device_register_init",
          device_mid: options.deviceMid,
          pass_hash: auth.passHash,
          meta: options.meta,
          client_ts: now(),
        });
        return;
      }
      if (auth?.deviceSid) sendAuthInit(auth.deviceSid);
    });
    next.on("message", (data) => {
      if (socket !== next) return;
      const text = data.toString("utf8");
      // 入站字节闸门：超限帧不能当成"解析失败的普通消息"吞掉，否则回放链路收不到
      // 任何降级信号，手机侧只会表现为偶发丢帧且永不 resync。
      if (Buffer.byteLength(text, "utf8") > RELAY_MAX_FRAME_BYTES) {
        options.logger.warn("[web-remote-control] oversize external relay message dropped", {
          bytes: Buffer.byteLength(text, "utf8"),
          maxBytes: RELAY_MAX_FRAME_BYTES,
        });
        options.onTransportFault?.("remote.rpcFrame.envelopeTooLarge");
        return;
      }
      handleMessage(parseRelayInboundFrame(text));
    });
    next.on("error", (error) => {
      if (socket !== next) return;
      options.logger.warn("[web-remote-control] external relay device socket error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    next.on("close", (code, reason) => {
      if (socket !== next) return;
      socket = undefined;
      heartbeat.stop();
      if (suppressNextCloseReconnect) {
        suppressNextCloseReconnect = false;
        return;
      }
      options.logger.info("[web-remote-control] external relay device disconnected", {
        code,
        reason: reason.toString("utf8") || undefined,
        wasPaired,
      });
      if (auth?.mode === "persisted" && !handshakeConfirmed && !invalidPersistedRetryUsed) {
        // 持久化 sid 在 relay 侧已不存在：链路已断，这里不再走错误帧那条"先关再重连"的路，
        // 否则 suppress 标记会残留并吃掉下一次正常断线的重连。清掉 sid 后立刻重新注册。
        invalidPersistedRetryUsed = true;
        if (auth) auth = { mode: "register", passHash: auth.passHash };
        options.onClearAuth("persisted-sid-rejected");
        deviceSid = undefined;
        scheduleReconnect(0);
        return;
      }
      // 任何非主动关闭都要立刻重连。这里不能再加状态判断：中继发来 KICKED 时状态仍是 paired，
      // 用 state!=='paired' 当门禁会把这条关闭整个跳过，设备只能等心跳超时（约 30s）才发现掉了。
      // scheduleReconnect 内部已有 manuallyClosed / terminalClose 守卫，主动 stop() 不会被误重连。
      scheduleReconnect();
    });
  };

  return {
    start: () => {
      if (socket) return;
      manuallyClosed = false;
      terminalClose = false;
      wasPaired = false;
      staleWaitingCount = 0;
      connect();
    },
    stop: (reason?: string) => {
      manuallyClosed = true;
      clearReconnectTimer();
      heartbeat.stop();
      clearStaleWaitingRecovery();
      pendingOutbound.clear("stopped");
      socket?.close();
      socket = undefined;
      setState("idle");
      options.logger.info("[web-remote-control] external relay device stopped", { reason });
    },
    sendPayload: (payload) => {
      const bytes = relayPhysicalFrameBytes(payload, now());
      if (bytes > RELAY_MAX_FRAME_BYTES) return { kind: "oversize", bytes };
      const canSend = state === "paired" && staleWaitingCount === 0;
      // 队列非空时新帧必须排队尾，否则直发会插到积压帧前面，终端收到乱序 RPC。
      if (!canSend || pendingOutbound.size() > 0) {
        pendingOutbound.enqueue(payload);
        if (canSend) pendingOutbound.flush();
        return { kind: "unavailable", bytes };
      }
      return rawSend({ type: "data", payload, client_ts: now() })
        ? { kind: "sent", bytes }
        : { kind: "unavailable", bytes };
    },
    getState: () => state,
    getDeviceSid: () => deviceSid,
  };
}
