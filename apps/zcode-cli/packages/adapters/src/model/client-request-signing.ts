/* eslint-disable max-lines -- Client Signing 是一套完整协议单元（gate/握手/签名/重试/降级），拆文件会分散握手与验签重试的时序约束。 */
// ============================================================
// Client Request Signing V4
// ============================================================
// 官方发行版中 Coding Plan 的额度折算（0.67 系数）由服务端在验签通过后应用；
// 客户端职责是给官方 Coding Plan 请求附加可验签的 X-Client-* header 族。
// 本模块实现：feature gate 查询、Ed25519 私钥握手、请求签名、验签被拒后的
// 重新握手重试与降级（bypass / fail-open）。

import {
  createClientRequestProofOfWork,
  createHandshakeSignature,
  decryptSigningPrivateKey,
  parseClientSigningCredential,
  randomHex,
  signBusinessMessage,
  type ParsedClientSigningCredential,
} from "./client-request-signing-crypto.js";

/** 私钥握手路径（挂在业务 provider origin 上）。 */
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
/** 客户端签名协议的应用标识，服务端按它区分签名协议版本。 */
const CLIENT_SIGNING_APP_ID = "zcode";
const HANDSHAKE_METHOD = "get_sign_key";
const CLIENT_SIGNING_NONCE_BYTES = 16;
const CLIENT_SIGNING_POW_BITS = 8;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const FEATURE_GATE_CACHE_TTL_MS = 3_600_000;
const FEATURE_GATE_TIMEOUT_MS = 15_000;
const OBSERVATION_STORE_MAX_REQUESTS = 64;
const VERIFY_SIGNATURE_INVALID = "VERIFY_SIGNATURE_INVALID";
const VERIFY_APIKEY_EXPIRED = "VERIFY_APIKEY_EXPIRED";
/** 每次发送前必须剥离的签名 header 族；含网关回显位，防止过期值透传。 */
const CLIENT_SIGNING_HEADER_NAMES = [
  "X-Client-Ts",
  "X-Client-Version",
  "X-Client-Sig",
  "X-Client-Nonce",
  "X-Client-Pow",
  "X-App-Id",
  "X-Client-Sign-Verified",
] as const;
const HANDSHAKE_REASON_PATTERN = /^HANDSHAKE_[A-Z_]+$/u;

export type ClientSigningFetch = typeof globalThis.fetch;
type SigningHeaders = Record<string, string>;
type SigningRequestInit = RequestInit & { timeoutMs?: number };

export type ClientRequestSigningErrorKind =
  | "invalid-config"
  | "cryptography"
  | "disposed"
  | "handshake-timeout"
  | "handshake-network"
  | "handshake-protocol"
  | "handshake-server"
  | "handshake-business";

export class ClientRequestSigningError extends Error {
  readonly kind: ClientRequestSigningErrorKind;
  /** 可恢复的握手类失败：降级为未签名请求继续发送，而不是让业务请求失败。 */
  readonly failOpenEligible: boolean;
  readonly reason?: string;
  readonly httpStatus?: number;
  readonly businessCode?: number | string;

  constructor(options: {
    kind: ClientRequestSigningErrorKind;
    message: string;
    cause?: unknown;
    failOpenEligible?: boolean;
    reason?: string;
    httpStatus?: number;
    businessCode?: number | string;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClientRequestSigningError";
    this.kind = options.kind;
    this.failOpenEligible = options.failOpenEligible ?? false;
    this.reason = options.reason;
    this.httpStatus = options.httpStatus;
    this.businessCode = options.businessCode;
  }
}

export function isFailOpenEligible(error: unknown): boolean {
  return error instanceof ClientRequestSigningError && error.failOpenEligible;
}

function signingError(
  kind: ClientRequestSigningErrorKind,
  message: string,
  options: {
    cause?: unknown;
    failOpenEligible?: boolean;
    reason?: string;
    httpStatus?: number;
    businessCode?: number | string;
  } = {},
): ClientRequestSigningError {
  return new ClientRequestSigningError({ kind, message, ...options });
}

// ------------------------------------------------------------
// 观测
// ------------------------------------------------------------

export type ClientSigningObservationKind =
  | "signed_sent"
  | "unsigned_sent"
  | "handshake_failed"
  | "verify_rejected"
  | "bypass_entered"
  | "request_failed_closed";

export interface ClientSigningObservation {
  kind: ClientSigningObservationKind;
  reason?: string;
  signedAttempt?: number;
  errorKind?: ClientRequestSigningErrorKind;
  httpStatus?: number;
  businessCode?: number | string;
  /**
   * signed_sent 时附带的本请求签名头取值（X-Client-* 全量）。
   * 取值逐请求变化（ts/nonce/sig/pow），非长期凭据；应用内诊断面板按用户
   * 要求完整展示，便于核对加签过程。不含 apiKey 本体。
   */
  headers?: Record<string, string>;
}

export interface ClientSigningObserverInput {
  observation: ClientSigningObservation;
  providerId: string;
  requestId?: string;
  sessionId?: string;
}

/** 按 x-request-id 归因的进程内观测记录；超出容量时按插入顺序淘汰最早的请求。 */
export class ClientSigningObservationStore {
  private readonly entries = new Map<string, ClientSigningObservation[]>();

  record(requestId: string, observation: ClientSigningObservation): void {
    let observations = this.entries.get(requestId);
    if (!observations) {
      if (this.entries.size >= OBSERVATION_STORE_MAX_REQUESTS) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) {
          this.entries.delete(oldestKey);
        }
      }
      observations = [];
      this.entries.set(requestId, observations);
    }
    observations.push(observation);
  }

  take(requestId: string): ClientSigningObservation[] {
    const observations = this.entries.get(requestId) ?? [];
    this.entries.delete(requestId);
    return observations;
  }

  get size(): number {
    return this.entries.size;
  }
}

export function readClientSigningRequestId(
  input: Parameters<ClientSigningFetch>[0],
  init?: SigningRequestInit,
): string | undefined {
  const headers =
    init?.headers === undefined
      ? undefined
      : init.headers instanceof Headers
        ? init.headers
        : new Headers(init.headers);
  const requestId =
    (headers?.get("x-request-id") ?? (input instanceof Request ? input.headers.get("x-request-id") : null))
      ?.trim() || undefined;
  return requestId;
}

// ------------------------------------------------------------
// Feature gate：按 API Key 查询服务端是否启用客户端签名
// ------------------------------------------------------------

export interface CodingPlanSignatureFeatureGateResult {
  cacheable: boolean;
  enabled: boolean;
  failure?: "http_status" | "business_code" | "malformed" | "timeout" | "network";
  httpStatus?: number;
}

export interface CodingPlanSignatureFeatureGateOptions {
  cacheTtlMs?: number;
  headers: SigningHeaders | (() => SigningHeaders);
  now?: () => number;
  onResult?: (result: CodingPlanSignatureFeatureGateResult) => void;
  timeoutMs?: number;
  transport?: ClientSigningFetch;
  url: string | (() => string);
}

export class CodingPlanSignatureFeatureGate {
  private readonly cacheTtlMs: number;
  private readonly headers: CodingPlanSignatureFeatureGateOptions["headers"];
  private readonly now: () => number;
  private readonly onResult?: CodingPlanSignatureFeatureGateOptions["onResult"];
  private readonly timeoutMs: number;
  private readonly transport?: ClientSigningFetch;
  private readonly url: CodingPlanSignatureFeatureGateOptions["url"];
  private requestPromise?: Promise<CodingPlanSignatureFeatureGateResult>;
  private snapshot?: { enabled: boolean; expiresAt: number };

  constructor(options: CodingPlanSignatureFeatureGateOptions) {
    this.cacheTtlMs = options.cacheTtlMs ?? FEATURE_GATE_CACHE_TTL_MS;
    this.headers = options.headers;
    this.now = options.now ?? Date.now;
    this.onResult = options.onResult;
    this.timeoutMs = options.timeoutMs ?? FEATURE_GATE_TIMEOUT_MS;
    this.transport = options.transport;
    this.url = options.url;
  }

  async isEnabled(signal?: AbortSignal): Promise<boolean> {
    if (this.snapshot && this.snapshot.expiresAt > this.now()) {
      return this.snapshot.enabled;
    }
    if (!this.requestPromise) {
      const pending = this.fetchFeatureResult().then((result) => {
        this.report(result);
        return result;
      });
      this.requestPromise = pending;
      const clearRequest = (): void => {
        if (this.requestPromise === pending) {
          this.requestPromise = undefined;
        }
      };
      pending.then(clearRequest, clearRequest);
    }
    const result = signal
      ? await waitForSigningPromiseOrAbort(this.requestPromise, signal)
      : await this.requestPromise;
    if (result.cacheable) {
      this.snapshot = { enabled: result.enabled, expiresAt: this.now() + this.cacheTtlMs };
    }
    return result.enabled;
  }

  private report(result: CodingPlanSignatureFeatureGateResult): void {
    try {
      this.onResult?.(result);
    } catch {
      // 观测回调失败不影响 gate 本身。
    }
  }

  private async fetchFeatureResult(): Promise<CodingPlanSignatureFeatureGateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.transport!(
        typeof this.url === "function" ? this.url() : this.url,
        {
          headers: typeof this.headers === "function" ? this.headers() : this.headers,
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return { cacheable: false, enabled: false, failure: "http_status", httpStatus: response.status };
      }
      const payload = asRecord(await response.json());
      if (payload?.code !== 0) {
        return { cacheable: false, enabled: false, failure: "business_code", httpStatus: response.status };
      }
      const data = asRecord(payload.data);
      if (!data || !Object.prototype.hasOwnProperty.call(data, "codingPlanSignature")) {
        return { cacheable: true, enabled: false, httpStatus: response.status };
      }
      return {
        cacheable: true,
        enabled: asRecord(data.codingPlanSignature)?.enable === true,
        httpStatus: response.status,
      };
    } catch {
      return {
        cacheable: false,
        enabled: false,
        failure: response ? "malformed" : controller.signal.aborted ? "timeout" : "network",
        ...(response ? { httpStatus: response.status } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ------------------------------------------------------------
// 私钥状态与缓存
// ------------------------------------------------------------

interface ClientRequestSigningKeyState {
  epoch: number;
  privateKey?: CryptoKey;
  handshakePromise?: Promise<CryptoKey>;
}

function createClientRequestSigningKeyState(): ClientRequestSigningKeyState {
  return { epoch: 0 };
}

/** 同一 API Key 在同一业务 origin 下的私钥复用；验签被拒后由 signer 主动失效。 */
export class ClientRequestSigningKeyCache {
  private readonly entries = new Map<string, Map<string, ClientRequestSigningKeyState>>();

  resolve(apiKey: string, handshakeUrl: string): ClientRequestSigningKeyState {
    let byOrigin = this.entries.get(apiKey);
    if (!byOrigin) {
      byOrigin = new Map();
      this.entries.set(apiKey, byOrigin);
    }
    const origin = new URL(handshakeUrl).origin;
    let state = byOrigin.get(origin);
    if (!state) {
      state = createClientRequestSigningKeyState();
      byOrigin.set(origin, state);
    }
    return state;
  }
}

/**
 * 跨 Execution 共享的签名状态：feature gate 与私钥都绑定 API Key，
 * 多个 provider / 多次 Execution 复用同一份，避免重复握手与 gate 查询。
 * 宿主可选注入；缺省时各 Execution 独立缓存。
 */
export class AiSdkClientRequestSigningState {
  readonly keyCache = new ClientRequestSigningKeyCache();
  private readonly featureGates = new Map<string, Map<string, CodingPlanSignatureFeatureGate>>();

  resolveFeatureGate(input: {
    apiKey: string;
    create: () => CodingPlanSignatureFeatureGate;
    scopeKey: string;
  }): CodingPlanSignatureFeatureGate {
    let byScope = this.featureGates.get(input.apiKey);
    if (!byScope) {
      byScope = new Map();
      this.featureGates.set(input.apiKey, byScope);
    }
    const cached = byScope.get(input.scopeKey);
    if (cached) {
      return cached;
    }
    const gate = input.create();
    byScope.set(input.scopeKey, gate);
    return gate;
  }
}

export function clientRequestSigningFeatureScopeKey(input: {
  configUrl: string | (() => string);
  headers: SigningHeaders | (() => SigningHeaders);
  network: { caCertFile?: string; httpProxy?: string; noProxy?: string };
}): string {
  return JSON.stringify({
    configUrl: input.configUrl,
    headers: Object.entries(input.headers).sort(([left], [right]) => left.localeCompare(right)),
    network: {
      caCertFile: input.network.caCertFile,
      httpProxy: input.network.httpProxy,
      noProxy: input.network.noProxy,
    },
  });
}

// ------------------------------------------------------------
// 可重放请求
// ------------------------------------------------------------

interface ReplayableSigningRequest {
  body?: Uint8Array<ArrayBuffer>;
  cache?: RequestCache;
  credentials?: RequestCredentials;
  headers: Headers;
  integrity?: string;
  keepalive?: boolean;
  method: string;
  mode?: RequestMode;
  redirect?: RequestRedirect;
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
  signal?: AbortSignal;
  timeoutMs?: number;
  url: string;
}

async function makeReplayableSigningRequest(
  input: Parameters<ClientSigningFetch>[0],
  init?: SigningRequestInit,
): Promise<ReplayableSigningRequest> {
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
  return {
    ...(body ? { body } : {}),
    cache: request.cache,
    credentials: request.credentials,
    headers: stripSigningHeaders(request.headers),
    integrity: request.integrity,
    keepalive: request.keepalive,
    method: request.method,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    ...(init?.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
    url: request.url,
  };
}

function buildSigningRequestInit(
  request: ReplayableSigningRequest,
  headers: Headers,
): SigningRequestInit {
  return {
    ...(request.body ? { body: request.body.slice() } : {}),
    cache: request.cache,
    credentials: request.credentials,
    headers,
    integrity: request.integrity,
    keepalive: request.keepalive,
    method: request.method,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  };
}

function stripSigningHeaders(headers: Headers): Headers {
  const stripped = new Headers(headers);
  for (const name of CLIENT_SIGNING_HEADER_NAMES) {
    stripped.delete(name);
  }
  return stripped;
}

async function detectVerifyRejection(response: Response): Promise<string | undefined> {
  if (response.status !== 401) return undefined;
  try {
    const payload = asRecord(await response.clone().json());
    if (!payload) return undefined;
    const data = asRecord(payload.data);
    const error = asRecord(payload.error);
    const reason = [payload.msg, payload.reason, data?.reason, error?.reason, error?.message].find(
      (value) => value === VERIFY_SIGNATURE_INVALID || value === VERIFY_APIKEY_EXPIRED,
    );
    return typeof reason === "string" ? reason : undefined;
  } catch {
    return undefined;
  }
}

function resolveHandshakeUrl(baseURL: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch (error) {
    throw signingError("invalid-config", "Client signing requires a valid baseURL.", { cause: error });
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw signingError("invalid-config", "Client signing handshake requires HTTPS.");
  }
  return new URL(HANDSHAKE_PATH, url.origin).toString();
}

function waitForSigningPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

// ------------------------------------------------------------
// Signer 与 Manager
// ------------------------------------------------------------

export interface ClientRequestSigningSignerConfig {
  apiKey: string;
  baseURL: string;
  clientVersion?: string;
  providerId: string;
}

export class ClientRequestSigningSigner {
  private readonly apiKey: string;
  private readonly clientVersion: string;
  private credential?: ParsedClientSigningCredential;
  private readonly businessOrigin: string;
  private readonly handshakeUrl: string;
  private readonly isEnabled: (apiKey: string, signal?: AbortSignal) => Promise<boolean>;
  private readonly keyState: ClientRequestSigningKeyState;
  private readonly ownsKeyState: boolean;
  private readonly transport: ClientSigningFetch;
  private readonly observer?: (input: ClientSigningObserverInput) => void;
  private readonly providerId: string;
  private activeRequestCount = 0;
  private bypassSigning = false;
  private disposed = false;
  private disposeRequested = false;

  constructor(
    config: ClientRequestSigningSignerConfig,
    transport: ClientSigningFetch,
    options: {
      allowInsecureHttp?: boolean;
      isEnabled?: (apiKey: string, signal?: AbortSignal) => Promise<boolean>;
      keyCache?: ClientRequestSigningKeyCache;
      observer?: (input: ClientSigningObserverInput) => void;
    },
    fallbackClientVersion: string,
  ) {
    this.apiKey = config.apiKey;
    this.clientVersion = config.clientVersion?.trim() || fallbackClientVersion;
    this.handshakeUrl = resolveHandshakeUrl(config.baseURL, options.allowInsecureHttp ?? false);
    this.businessOrigin = new URL(this.handshakeUrl).origin;
    this.isEnabled = options.isEnabled ?? (async () => false);
    this.keyState =
      options.keyCache?.resolve(this.apiKey, this.handshakeUrl) ??
      createClientRequestSigningKeyState();
    this.ownsKeyState = !options.keyCache;
    this.transport = transport;
    this.observer = options.observer;
    this.providerId = config.providerId;
  }

  dispose(): void {
    if (this.disposeRequested || this.disposed) {
      return;
    }
    this.disposeRequested = true;
    if (this.activeRequestCount > 0) return;
    this.finalizeDispose();
  }

  private beginRequest(): void {
    if (this.disposeRequested || this.disposed) {
      throw signingError("disposed", "Client request signer has been disposed.");
    }
    this.activeRequestCount += 1;
  }

  private endRequest(): void {
    this.activeRequestCount -= 1;
    if (this.activeRequestCount === 0 && this.disposeRequested) {
      this.finalizeDispose();
    }
  }

  private finalizeDispose(): void {
    this.disposed = true;
    if (this.ownsKeyState) {
      this.keyState.epoch += 1;
      this.keyState.privateKey = undefined;
      this.keyState.handshakePromise = undefined;
    }
  }

  async request(
    input: Parameters<ClientSigningFetch>[0],
    init?: SigningRequestInit,
  ): Promise<Response> {
    this.beginRequest();
    let request: ReplayableSigningRequest | undefined;
    try {
      request = await makeReplayableSigningRequest(input, init);
      if (new URL(request.url).origin !== this.businessOrigin) {
        return await this.sendUnsigned(request, "origin_mismatch");
      }
      if (this.bypassSigning) {
        return await this.sendUnsigned(request, "bypass");
      }
      try {
        if (!(await this.isEnabled(this.apiKey, request.signal))) {
          return await this.sendUnsigned(request, "feature_gate_disabled");
        }
      } catch (error) {
        if (request.signal?.aborted) throw error;
        return await this.sendUnsigned(request, "feature_gate_unavailable");
      }
      let key = await this.getKeyOrSendUnsigned(request);
      if (key instanceof Response) return key;
      let response = await this.sendSigned(request, key, 1);
      let rejection = await detectVerifyRejection(response);
      if (!rejection) return response;
      this.observe(request, { kind: "verify_rejected", reason: rejection, signedAttempt: 1 });
      this.invalidatePrivateKey(key);
      key = await this.getKeyOrSendUnsigned(request);
      if (key instanceof Response) return key;
      response = await this.sendSigned(request, key, 2);
      rejection = await detectVerifyRejection(response);
      if (rejection) {
        this.observe(request, { kind: "verify_rejected", reason: rejection, signedAttempt: 2 });
        this.invalidatePrivateKey(key);
        // 连续两次验签被拒说明该 Key / 环境无法恢复，本 signer 后续请求不再签名。
        this.bypassSigning = true;
        this.observe(request, { kind: "bypass_entered" });
        return await this.sendUnsigned(request, "verify_refresh_exhausted");
      }
      return response;
    } catch (error) {
      if (error instanceof ClientRequestSigningError && !request?.signal?.aborted) {
        this.observe(request, { errorKind: error.kind, kind: "request_failed_closed" });
      }
      throw error;
    } finally {
      this.endRequest();
    }
  }

  private observe(request: ReplayableSigningRequest | undefined, observation: ClientSigningObservation): void {
    if (!this.observer) return;
    const requestId = request?.headers.get("x-request-id")?.trim() || undefined;
    const sessionId = request?.headers.get("x-session-id")?.trim() || undefined;
    try {
      this.observer({
        observation,
        providerId: this.providerId,
        ...(requestId ? { requestId } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    } catch {
      // 观测回调失败不影响签名请求本身。
    }
  }

  private async getKeyOrSendUnsigned(
    request: ReplayableSigningRequest,
  ): Promise<CryptoKey | Response> {
    try {
      return await this.ensurePrivateKey(request);
    } catch (error) {
      if (isFailOpenEligible(error)) {
        return this.sendUnsigned(request, "handshake_failed");
      }
      throw error;
    }
  }

  private async sendSigned(
    request: ReplayableSigningRequest,
    privateKey: CryptoKey,
    signedAttempt: number,
  ): Promise<Response> {
    const credential = this.resolveCredential();
    const sessionId = request.headers.get("X-Session-Id")?.trim();
    if (!sessionId) {
      throw signingError("invalid-config", "Client request signing requires X-Session-Id.");
    }
    const headers = stripSigningHeaders(request.headers);
    const ts = String(Date.now());
    const nonce = randomHex(CLIENT_SIGNING_NONCE_BYTES);
    let proofOfWork: string;
    try {
      proofOfWork = await createClientRequestProofOfWork({
        apiKeyId: credential.apiKeyId,
        appId: CLIENT_SIGNING_APP_ID,
        powBits: CLIENT_SIGNING_POW_BITS,
        sessionId,
        signal: request.signal,
        ts,
      });
    } catch (error) {
      throw request.signal?.aborted
        ? error
        : signingError("cryptography", "Client request proof of work failed.", { cause: error });
    }
    let signature: string;
    try {
      signature = await signBusinessMessage(
        privateKey,
        `${credential.apiKeyId}\n${ts}\n${this.clientVersion}\n${sessionId}\n${nonce}`,
      );
    } catch (error) {
      throw signingError("cryptography", "Client request signing failed.", { cause: error });
    }
    headers.set("X-Client-Ts", ts);
    headers.set("X-Client-Version", this.clientVersion);
    headers.set("X-Client-Sig", signature);
    headers.set("X-Session-Id", sessionId);
    headers.set("X-Client-Nonce", nonce);
    headers.set("X-App-Id", CLIENT_SIGNING_APP_ID);
    headers.set("X-Client-Pow", proofOfWork);
    this.observe(request, {
      kind: "signed_sent",
      signedAttempt,
      headers: {
        "x-app-id": CLIENT_SIGNING_APP_ID,
        "x-client-ts": ts,
        "x-client-version": this.clientVersion,
        "x-client-nonce": nonce,
        "x-client-sig": signature,
        "x-client-pow": proofOfWork,
        "x-session-id": sessionId,
      },
    });
    return this.transport(request.url, buildSigningRequestInit(request, headers));
  }

  private sendUnsigned(request: ReplayableSigningRequest, reason: string): Promise<Response> {
    this.observe(request, { kind: "unsigned_sent", reason });
    return this.transport(request.url, buildSigningRequestInit(request, stripSigningHeaders(request.headers)));
  }

  private invalidatePrivateKey(privateKey: CryptoKey): void {
    if (this.keyState.privateKey === privateKey) {
      this.keyState.epoch += 1;
      this.keyState.privateKey = undefined;
      this.keyState.handshakePromise = undefined;
    }
  }

  private async ensurePrivateKey(request: ReplayableSigningRequest): Promise<CryptoKey> {
    const signal = request.signal;
    if (this.disposed) {
      throw signingError("disposed", "Client request signer has been disposed.");
    }
    if (this.keyState.privateKey) return this.keyState.privateKey;
    this.resolveCredential();
    if (this.keyState.handshakePromise) {
      return signal
        ? waitForSigningPromiseOrAbort(this.keyState.handshakePromise, signal)
        : this.keyState.handshakePromise;
    }
    const epoch = this.keyState.epoch;
    const handshake = this.performHandshake()
      .catch((error: unknown) => {
        if (error instanceof ClientRequestSigningError) {
          this.observe(request, {
            kind: "handshake_failed",
            ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
            ...(error.businessCode !== undefined ? { businessCode: error.businessCode } : {}),
            ...(error.reason ? { reason: error.reason } : {}),
          });
        }
        throw error;
      })
      .then((privateKey) => {
        if ((this.ownsKeyState && this.disposed) || this.keyState.epoch !== epoch) {
          throw signingError("disposed", "Client request signer changed during handshake.");
        }
        this.keyState.privateKey = privateKey;
        return privateKey;
      });
    this.keyState.handshakePromise = handshake;
    const clearHandshake = (): void => {
      if (this.keyState.handshakePromise === handshake) {
        this.keyState.handshakePromise = undefined;
      }
    };
    handshake.then(clearHandshake, clearHandshake);
    return signal ? waitForSigningPromiseOrAbort(handshake, signal) : handshake;
  }

  private async performHandshake(): Promise<CryptoKey> {
    const credential = this.resolveCredential();
    const ts = String(Date.now());
    const nonce = randomHex(CLIENT_SIGNING_NONCE_BYTES);
    let handshakeSignature: string;
    try {
      handshakeSignature = await createHandshakeSignature(
        credential.apiKeySecret,
        `${HANDSHAKE_METHOD}\n${credential.apiKeyId}\n${ts}\n${nonce}`,
      );
    } catch (error) {
      throw signingError("cryptography", "Client signing handshake signature failed.", {
        cause: error,
        failOpenEligible: true,
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.transport(this.handshakeUrl, {
          body: JSON.stringify({ apiKey: credential.credential, nonce, sig: handshakeSignature, ts }),
          headers: { Authorization: credential.credential, "Content-Type": "application/json" },
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = controller.signal.aborted;
        throw signingError(
          timedOut ? "handshake-timeout" : "handshake-network",
          timedOut
            ? "Client signing handshake timed out."
            : "Client signing handshake failed.",
          { cause: error, failOpenEligible: true },
        );
      }
      if (response.status !== 200) {
        throw signingError("handshake-protocol", "Client signing handshake HTTP status is invalid.", {
          failOpenEligible: true,
          httpStatus: response.status,
        });
      }
      let payload: Record<string, unknown>;
      try {
        payload = asRecord(await response.json()) ?? {};
      } catch (error) {
        const timedOut = controller.signal.aborted;
        throw signingError(
          timedOut ? "handshake-timeout" : "handshake-protocol",
          timedOut
            ? "Client signing handshake timed out."
            : "Client signing handshake JSON is invalid.",
          { cause: error, failOpenEligible: true },
        );
      }
      if (payload.code === 500) {
        throw signingError("handshake-server", "Client signing handshake reported code 500.", {
          businessCode: 500,
          failOpenEligible: true,
        });
      }
      if (payload.code !== 200) {
        throw signingError("handshake-business", "Client signing handshake was rejected.", {
          ...(typeof payload.code === "number" ? { businessCode: payload.code } : {}),
          failOpenEligible: true,
          reason: readHandshakeReason(payload.msg),
        });
      }
      const privateCipher = asRecord(payload.data)?.privateCipher;
      if (typeof privateCipher !== "string" || !privateCipher) {
        throw signingError("handshake-protocol", "Client signing handshake omitted privateCipher.", {
          failOpenEligible: true,
        });
      }
      try {
        return await decryptSigningPrivateKey(credential.apiKeyId, credential.apiKeySecret, privateCipher);
      } catch (error) {
        throw signingError("cryptography", "Client signing private key is invalid.", {
          cause: error,
          failOpenEligible: true,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveCredential(): ParsedClientSigningCredential {
    if (this.credential) return this.credential;
    const credential = parseClientSigningCredential(this.apiKey);
    if (!credential) {
      throw signingError("invalid-config", "Client signing credential must contain one separator.");
    }
    this.credential = credential;
    return credential;
  }
}

export class ClientRequestSigningManager {
  private readonly entries = new Map<
    string,
    {
      apiKey: string;
      baseURL: string;
      clientVersion: string;
      signer: ClientRequestSigningSigner;
      transport: ClientSigningFetch;
    }
  >();
  private readonly allowInsecureHttp: boolean;
  private readonly isEnabled: (apiKey: string, signal?: AbortSignal) => Promise<boolean>;
  private readonly keyCache?: ClientRequestSigningKeyCache;
  private readonly observer?: (input: ClientSigningObserverInput) => void;

  constructor(options: {
    allowInsecureHttp?: boolean;
    isEnabled?: (apiKey: string, signal?: AbortSignal) => Promise<boolean>;
    keyCache?: ClientRequestSigningKeyCache;
    observer?: (input: ClientSigningObserverInput) => void;
  } = {}) {
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.isEnabled = options.isEnabled ?? (async () => false);
    this.keyCache = options.keyCache;
    this.observer = options.observer;
  }

  createFetch(config: ClientRequestSigningSignerConfig, transport: ClientSigningFetch): ClientSigningFetch {
    const signer = this.resolveSigner(config, transport);
    return (input, init) => signer.request(input, init as SigningRequestInit | undefined);
  }

  dispose(providerId?: string): void {
    if (providerId) {
      this.entries.get(providerId)?.signer.dispose();
      this.entries.delete(providerId);
      return;
    }
    for (const entry of this.entries.values()) {
      entry.signer.dispose();
    }
    this.entries.clear();
  }

  private resolveSigner(
    config: ClientRequestSigningSignerConfig,
    transport: ClientSigningFetch,
  ): ClientRequestSigningSigner {
    const clientVersion = config.clientVersion ?? DEFAULT_CLIENT_SIGNING_VERSION;
    const current = this.entries.get(config.providerId);
    if (
      current?.apiKey === config.apiKey &&
      current.baseURL === config.baseURL &&
      current.clientVersion === clientVersion &&
      current.transport === transport
    ) {
      return current.signer;
    }
    current?.signer.dispose();
    const signer = new ClientRequestSigningSigner(
      config,
      transport,
      {
        allowInsecureHttp: this.allowInsecureHttp,
        isEnabled: this.isEnabled,
        keyCache: this.keyCache,
        observer: this.observer,
      },
      DEFAULT_CLIENT_SIGNING_VERSION,
    );
    this.entries.set(config.providerId, {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      clientVersion,
      signer,
      transport,
    });
    return signer;
  }
}

export const DEFAULT_CLIENT_SIGNING_VERSION = "0.0.0-dev";

function readHandshakeReason(value: unknown): string | undefined {
  return typeof value === "string" && HANDSHAKE_REASON_PATTERN.test(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
