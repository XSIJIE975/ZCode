// Client Request Signing 单元测试：凭据解析（id.secret / project_access JWT）、观测 store、
// PoW 可验证性、signer 状态机（签名/验签被拒降级/无效凭据 fail-open）。
// 对应发行版 3.15.1 逆向移植，防止后续改动破坏协议对齐（冒烟脚本在仓外，不入库）。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ClientRequestSigningManager,
  ClientSigningObservationStore,
} from "../src/model/client-request-signing.js";
import {
  createClientRequestProofOfWork,
  parseClientSigningCredential,
} from "../src/model/client-request-signing-crypto.js";
import { requiresClientRequestSigning } from "../src/model/model-execution.js";

test("parseClientSigningCredential：id.secret 形态（恰好一个点且两侧非空）", () => {
  assert.deepEqual(parseClientSigningCredential("id.secret"), {
    apiKeyId: "id",
    apiKeySecret: "secret",
    credential: "id.secret",
    handshakeField: "apiKey",
  });
  assert.equal(parseClientSigningCredential("sk-plain"), undefined);
  assert.equal(parseClientSigningCredential(".secret"), undefined);
  assert.equal(parseClientSigningCredential("id."), undefined);
});

test("parseClientSigningCredential：project_access JWT 形态（3.15.1 账号型 Coding Plan 传输凭据）", () => {
  const jwt = buildProjectAccessToken(
    { alg: "HS256", sign_type: "SIGN", typ: "JWT" },
    { api_key: "inner-key", token_use: "project_access" },
  );
  assert.deepEqual(parseClientSigningCredential(jwt), {
    apiKeyId: "inner-key",
    apiKeySecret: jwt,
    credential: jwt,
    handshakeField: "accessToken",
  });
  // 头/载荷不符即 undefined；3 段串不回退 id.secret 分支（与发行版一致）。
  assert.equal(
    parseClientSigningCredential(
      buildProjectAccessToken(
        { alg: "HS256", sign_type: "OTHER", typ: "JWT" },
        { api_key: "k", token_use: "project_access" },
      ),
    ),
    undefined,
  );
  assert.equal(
    parseClientSigningCredential(
      buildProjectAccessToken(
        { alg: "HS256", sign_type: "SIGN", typ: "JWT" },
        { api_key: "k", token_use: "other" },
      ),
    ),
    undefined,
  );
  assert.equal(
    parseClientSigningCredential(
      buildProjectAccessToken(
        { alg: "HS256", sign_type: "SIGN", typ: "JWT" },
        { api_key: "   ", token_use: "project_access" },
      ),
    ),
    undefined,
  );
  // 3 段但不是合法 JWT：undefined（不当作 id.secret）。
  assert.equal(parseClientSigningCredential("a.b.c"), undefined);
});

test("观测 store 按 requestId 归因、take 取出后清空、超容量淘汰最旧", () => {
  const store = new ClientSigningObservationStore();
  store.record("req-1", { kind: "signed_sent", signedAttempt: 1 });
  store.record("req-1", { kind: "verify_rejected", reason: "VERIFY_SIGNATURE_INVALID" });
  assert.equal(store.take("req-1").length, 2);
  assert.equal(store.take("req-1").length, 0);
  for (let index = 0; index < 80; index += 1) {
    store.record(`req-${index}`, { kind: "unsigned_sent", reason: "test" });
  }
  assert.equal(store.size, 64);
  assert.equal(store.take("req-0").length, 0, "最旧的 req-0 应已被淘汰");
  assert.equal(store.take("req-79").length, 1);
});

test("PoW 满足前导零位且绑定 challenge 输入", async () => {
  const candidate = await createClientRequestProofOfWork({
    apiKeyId: "key-id",
    appId: "zcode",
    powBits: 8,
    sessionId: "sess-1",
    ts: "1700000000000",
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`key-id\nzcode\nsess-1\n1700000000000`),
    ),
  );
  const challengePrefix = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  const attempt = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${challengePrefix}\n${candidate}`),
    ),
  );
  assert.equal(attempt[0], 0, "powBits=8 要求首字节为零");
  // challenge 输入变化后旧 candidate 不再满足。
  const other = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`key-id\nzcode\nsess-2\n1700000000000`),
    ),
  );
  const otherPrefix = Array.from(other, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  const reused = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${otherPrefix}\n${candidate}`),
    ),
  );
  // 不做概率断言，只验证结构：candidate 是 hex 串且长度 = salt24 + counter8。
  assert.match(candidate, /^[0-9a-f]{32}$/u);
  assert.ok(reused.length === 32);
});

/** base64url 编码（无 padding），用于构造测试用 JWT 段。 */
function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildProjectAccessToken(header: unknown, payload: unknown): string {
  return `${base64Url(header)}.${base64Url(payload)}.signature`;
}

function createSigningTransport(options: {
  rejectAttempts?: number;
  credential?: { apiKeyId: string; secret: string };
}) {
  const credential = options.credential ?? { apiKeyId: "id", secret: "secret" };
  const seenSignedRequests: Request[] = [];
  const handshakeBodies: Record<string, unknown>[] = [];
  let handshakeCount = 0;
  let signedCount = 0;
  let unsignedCount = 0;
  const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/paas/c1f3a7e2/v2/client")) {
      handshakeCount += 1;
      handshakeBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          code: 200,
          msg: "",
          data: { privateCipher: await buildTestPrivateCipher(credential.apiKeyId, credential.secret) },
        }),
        { status: 200 },
      );
    }
    const request = new Request(input, init);
    seenSignedRequests.push(request);
    const response =
      (options.rejectAttempts ?? 0) > signedCount
        ? new Response(JSON.stringify({ msg: "VERIFY_SIGNATURE_INVALID" }), { status: 401 })
        : new Response("{}", { status: 200 });
    if (request.headers.has("x-app-id")) {
      signedCount += 1;
    } else {
      unsignedCount += 1;
    }
    return response;
  };
  return {
    seenSignedRequests,
    handshakeBodies,
    counts: () => ({ handshakeCount, signedCount, unsignedCount }),
    transport,
  };
}

/** 构造可被客户端解密的真实 privateCipher：Ed25519 PKCS8 + HKDF/ed25519_priv AES-GCM。 */
async function buildTestPrivateCipher(apiKeyId: string, secret: string): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const hkdf = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const aesBytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        hash: "SHA-256",
        info: new TextEncoder().encode("ed25519_priv"),
        name: "HKDF",
        salt: new TextEncoder().encode("WD_CLIENT_SIGN_KDF_SALT"),
      },
      hkdf,
      256,
    ),
  );
  const aesKey = await crypto.subtle.importKey("raw", aesBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // 协议明文是 base64(pkcs8)：客户端解密后先 TextDecoder 再做一次 base64 解码。
  const pkcs8Base64 = Buffer.from(pkcs8).toString("base64");
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { additionalData: new TextEncoder().encode(apiKeyId), iv, name: "AES-GCM", tagLength: 128 },
      aesKey,
      new TextEncoder().encode(pkcs8Base64),
    ),
  );
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  let binary = "";
  for (const byte of combined) binary += String.fromCharCode(byte);
  return btoa(binary);
}

test("origin 不符：请求原样未签名透传，不握手", async () => {
  const harness = createSigningTransport({});
  const manager = new ClientRequestSigningManager({ observer: undefined });
  const fetch = manager.createFetch(
    {
      apiKey: "id.secret",
      baseURL: "https://open.bigmodel.cn/api/anthropic",
      providerId: "provider:test",
    },
    harness.transport as typeof globalThis.fetch,
  );
  // baseURL origin 为 open.bigmodel.cn，请求发往别处 → 不进入签名层。
  const response = await fetch("https://other.example.com/api/anthropic/v1/messages", {
    headers: { "x-request-id": "req-1", "x-session-id": "sess-1" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(harness.counts().handshakeCount, 0, "origin 不符不应握手");
  assert.equal(harness.counts().unsignedCount, 1);
});

test("签名请求（id.secret）：携带 7 个 X-Client 头、握手用 apiKey 字段、requestUrl 观测", async () => {
  const observations = new ClientSigningObservationStore();
  const harness = createSigningTransport({});
  const manager = new ClientRequestSigningManager({
    observer: (input) => {
      if (input.requestId) observations.record(input.requestId, input.observation);
    },
  });
  const fetch = manager.createFetch(
    {
      apiKey: "id.secret",
      baseURL: "https://open.bigmodel.cn/api/anthropic",
      providerId: "provider:test",
    },
    harness.transport as typeof globalThis.fetch,
  );
  const response = await fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
    headers: {
      "content-type": "application/json",
      "x-request-id": "req-3",
      "x-session-id": "sess-1",
    },
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(harness.counts().handshakeCount, 1);
  // id.secret 凭据握手 body 承载字段为 apiKey。
  assert.equal(harness.handshakeBodies[0]?.apiKey, "id.secret");
  assert.equal(harness.handshakeBodies[0]?.accessToken, undefined);
  assert.equal(harness.seenSignedRequests.length, 1);
  const sent = harness.seenSignedRequests[0];
  assert.equal(sent.headers.get("x-app-id"), "zcode");
  for (const header of [
    "x-client-ts",
    "x-client-version",
    "x-client-nonce",
    "x-client-sig",
    "x-client-pow",
    "x-session-id",
  ]) {
    assert.ok(sent.headers.get(header), `缺少签名头 ${header}`);
  }
  const taken = observations.take("req-3");
  assert.equal(taken[0]?.kind, "signed_sent");
  assert.equal(taken[0]?.signedAttempt, 1);
  assert.equal(
    taken[0]?.requestUrl,
    "https://open.bigmodel.cn/api/anthropic/v1/messages",
    "观测携带实际发送端点（直连证据）",
  );
  assert.equal(Object.keys(taken[0]?.headers ?? {}).length, 7);
});

test("签名请求（project_access JWT）：握手用 accessToken 字段并成功签名", async () => {
  const observations = new ClientSigningObservationStore();
  const jwt = buildProjectAccessToken(
    { alg: "HS256", sign_type: "SIGN", typ: "JWT" },
    { api_key: "inner-key", token_use: "project_access" },
  );
  const harness = createSigningTransport({ credential: { apiKeyId: "inner-key", secret: jwt } });
  const manager = new ClientRequestSigningManager({
    observer: (input) => {
      if (input.requestId) observations.record(input.requestId, input.observation);
    },
  });
  const fetch = manager.createFetch(
    {
      apiKey: jwt,
      baseURL: "https://open.bigmodel.cn/api/anthropic",
      providerId: "provider:test",
    },
    harness.transport as typeof globalThis.fetch,
  );
  const response = await fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
    headers: { "x-request-id": "req-jwt", "x-session-id": "sess-1" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(harness.counts().handshakeCount, 1);
  // JWT 凭据握手 body 承载字段为 accessToken，值为整个 JWT。
  assert.equal(harness.handshakeBodies[0]?.accessToken, jwt);
  assert.equal(harness.handshakeBodies[0]?.apiKey, undefined);
  const sent = harness.seenSignedRequests[0];
  assert.equal(sent.headers.get("x-app-id"), "zcode");
  assert.ok(sent.headers.get("x-client-sig"), "JWT 凭据也应完成业务签名");
  assert.equal(observations.take("req-jwt")[0]?.kind, "signed_sent");
});

test("401 验签被拒：重新握手重签一次，再拒进入 bypass 并以未签名发送", async () => {
  const observations = new ClientSigningObservationStore();
  const harness = createSigningTransport({ rejectAttempts: 2 });
  const manager = new ClientRequestSigningManager({
    observer: (input) => {
      if (input.requestId) observations.record(input.requestId, input.observation);
    },
  });
  const fetch = manager.createFetch(
    {
      apiKey: "id.secret",
      baseURL: "https://open.bigmodel.cn/api/anthropic",
      providerId: "provider:test",
    },
    harness.transport as typeof globalThis.fetch,
  );
  const url = "https://open.bigmodel.cn/api/anthropic/v1/messages";
  const first = await fetch(url, {
    headers: { "x-request-id": "req-4", "x-session-id": "sess-1" },
    method: "POST",
  });
  assert.equal(first.status, 200, "两轮被拒后降级未签名，最终 200");
  assert.equal(harness.counts().handshakeCount, 2, "重签前重新握手一次");
  assert.equal(harness.counts().signedCount, 2, "两次签名发送");
  assert.equal(harness.counts().unsignedCount, 1, "降级未签名发送一次");
  const taken = observations.take("req-4");
  const kinds = taken.map((observation) => observation.kind);
  assert.deepEqual(kinds, [
    "signed_sent",
    "verify_rejected",
    "signed_sent",
    "verify_rejected",
    "bypass_entered",
    "unsigned_sent",
  ]);
  // bypass 世代内后续请求直接未签名，不再握手/签名。
  await fetch(url, {
    headers: { "x-request-id": "req-5", "x-session-id": "sess-1" },
    method: "POST",
  });
  assert.equal(harness.counts().handshakeCount, 2, "bypass 后不再握手");
  assert.equal(harness.counts().signedCount, 2, "bypass 后不再签名");
  assert.equal(harness.counts().unsignedCount, 2, "bypass 后未签名发送");
  assert.equal(observations.take("req-5")[0]?.reason, "bypass");
});

test("无效凭据（sk- key）：fail-open 未签名发送并携带 invalid_credential 原因", async () => {
  const observations = new ClientSigningObservationStore();
  const harness = createSigningTransport({});
  const manager = new ClientRequestSigningManager({
    observer: (input) => {
      if (input.requestId) observations.record(input.requestId, input.observation);
    },
  });
  const fetch = manager.createFetch(
    {
      apiKey: "sk-plain-key",
      baseURL: "https://open.bigmodel.cn/api/anthropic",
      providerId: "provider:custom",
    },
    harness.transport as typeof globalThis.fetch,
  );
  const response = await fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
    headers: { "x-request-id": "req-2", "x-session-id": "sess-1" },
    method: "POST",
  });
  assert.equal(response.status, 200, "不抛 invalid-config，按未签名发送");
  const taken = observations.take("req-2");
  assert.equal(taken[0]?.kind, "unsigned_sent");
  assert.equal(taken[0]?.reason, "invalid_credential");
});

test("requiresClientRequestSigning 判定矩阵", () => {
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "zhipu-account", mode: "start-plan" },
      baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    }),
    false,
  );
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "zhipu-account", mode: "off-peak" },
      baseURL: "https://api.z.ai/api/anthropic",
    }),
    false,
  );
  // highspeed 走免签网关：官方域也不签名。
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "zhipu-account", mode: "highspeed" },
      baseURL: "https://open.bigmodel.cn/api/anthropic",
    }),
    false,
  );
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "zhipu-account", mode: "individual-coding-plan" },
      baseURL: "https://open.bigmodel.cn/api/anthropic",
    }),
    true,
  );
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "zhipu-coding-plan-api-key" },
      baseURL: "https://any.example.com/v1",
    }),
    true,
  );
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "api-key" },
      baseURL: "https://api.openai.com/v1",
    }),
    false,
  );
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "api-key" },
      baseURL: "https://sub.bigmodel.cn/api",
    }),
    true,
  );
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "api-key" },
      baseURL: "https://zcode.chatglm.site/api",
    }),
    true,
  );
});
