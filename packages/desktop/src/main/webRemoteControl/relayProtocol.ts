import { createHash, createHmac, randomBytes } from "node:crypto";

// 外部中继（external relay）设备端协议常量与凭据原语。
// 字段名与取值语义来自对官方发行版运行时行为的可观测约定（帧类型、查询参数、请求头），
// 本文件是据此重新实现的等价客户端，不包含厂商代码。

export const EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY =
  "web-remote-control:external-relay:pass_hash";
export const EXTERNAL_RELAY_DEVICE_SETTING_KEY = "webRemoteControlExternalRelayDevice";
export const EXTERNAL_RELAY_LAST_CONTEXT_SETTING_KEY = "webRemoteControlLastEnabledContext";

export const DEFAULT_RELAY_HEARTBEAT_INTERVAL_MS = 10_000;
/** 抖动上限占心跳周期的比例，同时被 clamp 到 {@link RELAY_JITTER_MAX_MS}。 */
export const DEFAULT_RELAY_HEARTBEAT_JITTER_RATIO = 0.2;
export const DEFAULT_RELAY_HEARTBEAT_ACK_TIMEOUT_MS = 30_000;
export const DEFAULT_RELAY_RECONNECT_DELAY_MS = 1_000;
export const DEFAULT_RELAY_RECONNECT_JITTER_MS = 2_000;
/** 抖动绝对上限：心跳与重连的抖动都不会超过这个幅度。 */
export const RELAY_JITTER_MAX_MS = 2_000;
export const RELAY_MAX_FRAME_BYTES = 1024 * 1024;
export const RELAY_PASSWORD_BYTES = 24;

export type ExternalRelayRole = "device" | "terminal";
export type ExternalRelayPairStatus = "waiting" | "matched";

export type ExternalRelayDeviceState =
  | "idle"
  | "connecting"
  | "registering"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "error";

/** 注册帧里的设备元信息。字段名以发行版为准：版本键是 version，不是 app_version。 */
export interface ExternalRelayMeta {
  name?: string;
  version?: string;
  platform?: string;
}

export interface ExternalRelayRegisterInit {
  type: "device_register_init";
  device_mid: string;
  pass_hash: string;
  meta: ExternalRelayMeta;
  client_ts: number;
}

export interface ExternalRelayRegisterAck {
  type: "device_register_ack";
  device_sid: string;
}

export interface ExternalRelayAuthInit {
  type: "auth_init";
  role: ExternalRelayRole;
  device_sid: string;
  meta: ExternalRelayMeta;
  client_ts: number;
}

export interface ExternalRelayAuthChallenge {
  type: "auth_challenge";
  nonce: string;
}

export interface ExternalRelayAuthResponse {
  type: "auth_response";
  device_sid: string;
  proof: string;
  client_ts: number;
}

export interface ExternalRelayPairStatusQuery {
  type: "pair_status_query";
  device_sid: string;
  client_ts: number;
}

export interface ExternalRelayPairStatusAck {
  type: "pair_status_ack" | "auth_ack";
  pair_status: ExternalRelayPairStatus;
}

export interface ExternalRelayDataFrame {
  type: "data";
  payload: unknown;
  client_ts: number;
}

export interface ExternalRelayErrorFrame {
  type: "error";
  code?: string;
  message?: string;
}

export type ExternalRelayInboundFrame =
  | ExternalRelayRegisterAck
  | ExternalRelayAuthChallenge
  | ExternalRelayPairStatusAck
  | ExternalRelayDataFrame
  | ExternalRelayErrorFrame
  | { type: string };

export interface ExternalRelayCredentials {
  password: string;
  passHash: string;
}

/** 会话口令只在内存持有；中继侧只登记它的摘要。 */
export function createExternalRelayPassword(): string {
  return randomBytes(RELAY_PASSWORD_BYTES).toString("base64url");
}

export function createExternalRelayPassHash(password: string): string {
  return createHash("sha256").update(password).digest("base64");
}

export function createExternalRelayCredentials(): ExternalRelayCredentials {
  const password = createExternalRelayPassword();
  return { password, passHash: createExternalRelayPassHash(password) };
}

/**
 * proof = base64url(HMAC-SHA256(key=passHash, `${nonce}|${role}|${deviceSid}`))
 * role 参与签名，因此 device 侧算出的 proof 无法被 terminal 侧重放。
 */
export function calculateExternalRelayProof(input: {
  passHash: string;
  nonce: string;
  role: ExternalRelayRole;
  deviceSid: string;
}): string {
  return createHmac("sha256", input.passHash)
    .update(`${input.nonce}|${input.role}|${input.deviceSid}`)
    .digest("base64url");
}

export function buildExternalRelayWsUrl(relayWsUrl: string, deviceMid: string): string {
  const url = new URL(relayWsUrl);
  url.searchParams.set("mid", deviceMid);
  return url.toString();
}

export function buildExternalRelayWsHeaders(deviceMid: string): Record<string, string> {
  return { "X-Device-ID": deviceMid };
}

/** 随机源可能来自注入，非有限值退化为 0，上界取开区间避免抖动溢出。 */
function safeUnitRandom(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(0.999_999_999, Math.max(0, value)) : 0;
}

/**
 * 抖动幅度：默认取「心跳周期的 20%」与上限的较小值，可被显式覆盖。
 * 传入非正数表示关闭抖动（返回 0），心跳退化为固定周期。
 */
export function resolveRelayHeartbeatJitterMs(
  intervalMs: number = DEFAULT_RELAY_HEARTBEAT_INTERVAL_MS,
  jitterMs?: number,
): number {
  const base =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.floor(intervalMs)
      : DEFAULT_RELAY_HEARTBEAT_INTERVAL_MS;
  const cap = Math.min(
    RELAY_JITTER_MAX_MS,
    Math.floor(base * DEFAULT_RELAY_HEARTBEAT_JITTER_RATIO),
  );
  const requested = jitterMs ?? cap;
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(Math.floor(requested), Math.max(0, base - 1));
}

/** 心跳加抖动，避免同一时刻大量桌面同时发起 pair_status_query。抖动是半宽：10s 心跳落在 [8s, 12s]。 */
export function resolveRelayHeartbeatDelay(
  intervalMs: number = DEFAULT_RELAY_HEARTBEAT_INTERVAL_MS,
  jitterMs?: number,
  random: () => number = Math.random,
): number {
  const base =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.floor(intervalMs)
      : DEFAULT_RELAY_HEARTBEAT_INTERVAL_MS;
  const spread = resolveRelayHeartbeatJitterMs(base, jitterMs);
  const min = Math.max(1, base - spread);
  const max = base + spread;
  return min + Math.floor(safeUnitRandom(random) * (max - min + 1));
}

/** 重连抖动只用在异常路径（ack 超时、stale waiting）；普通断线重连是固定延时。 */
export function resolveRelayReconnectJitterMs(
  jitterMs: number = DEFAULT_RELAY_RECONNECT_JITTER_MS,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(jitterMs) || jitterMs <= 0) return 0;
  return Math.floor(safeUnitRandom(random) * (Math.floor(jitterMs) + 1));
}

export interface ExternalRelayAuthLogFields {
  hasDeviceSid: boolean;
  deviceSidSuffix?: string;
  hasPassHash: boolean;
}

/** passHash 与 password 等值同权（都能算出 proof），日志只允许出现长度与后缀。 */
export function describeExternalRelayAuthForLog(input: {
  deviceSid?: string;
  passHash?: string;
}): ExternalRelayAuthLogFields {
  const deviceSid = input.deviceSid?.trim();
  return {
    hasDeviceSid: Boolean(deviceSid),
    deviceSidSuffix: deviceSid ? deviceSid.slice(-6) : undefined,
    hasPassHash: Boolean(input.passHash?.trim()),
  };
}
