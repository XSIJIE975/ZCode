import {
  DEFAULT_RELAY_HEARTBEAT_ACK_TIMEOUT_MS,
  DEFAULT_RELAY_HEARTBEAT_INTERVAL_MS,
  resolveRelayHeartbeatDelay,
} from "./relayProtocol.js";

// 中继链路的保活与 ack 看门狗。
// 两者是一对：心跳负责周期性发 pair_status_query，看门狗负责在长时间收不到 ack 时判定链路已死。
// 关闭链路时两条必须一起停——心跳会往死链路上发帧，看门狗会在重连之外再触发一次重连。

export interface RelayHeartbeatDeps {
  /** 链路是否还值得保活（paired 或等待终端配对）。 */
  isAlive: () => boolean;
  /** 本轮是否可以发查询帧（deviceSid 是否就绪）。 */
  canQuery: () => boolean;
  query: () => void;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
  /** 看门狗到期：由传输层决定如何放弃当前链路重来。 */
  onAckTimeout: () => void;
  now: () => number;
}

export interface RelayHeartbeat {
  /** 幂等：已在跑就不再武装第二条看门狗。 */
  start: () => void;
  /** 收到一次 pair_status ack 后调用，把看门狗推回 30s。 */
  rearm: () => void;
  stop: () => void;
}

export function createRelayHeartbeat(deps: RelayHeartbeatDeps): RelayHeartbeat {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAckAt = 0;

  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      if (!deps.canQuery() || !deps.isAlive()) return;
      deps.query();
      schedule();
    }, resolveRelayHeartbeatDelay(DEFAULT_RELAY_HEARTBEAT_INTERVAL_MS));
    timer.unref?.();
  };

  /**
   * ack 看门狗是一次性 30s 定时器，每收到一次 pair_status ack 重新武装，因此实际语义是
   * 「距最后一次 ack 30s」。轮询实现会把触发点推到 30–35s，且期间重复判定同一次超时。
   */
  const rearm = (): void => {
    if (!deps.isAlive()) return;
    lastAckAt = deps.now();
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogTimer = undefined;
      if (!deps.isAlive()) return;
      deps.logger.warn("[web-remote-control] external relay heartbeat ack timeout", {
        staleMs: deps.now() - lastAckAt,
      });
      deps.onAckTimeout();
    }, DEFAULT_RELAY_HEARTBEAT_ACK_TIMEOUT_MS);
    watchdogTimer.unref?.();
  };

  return {
    start: () => {
      if (timer) return;
      rearm();
      schedule();
    },
    rearm,
    stop: () => {
      clearTimeout(timer);
      timer = undefined;
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    },
  };
}
