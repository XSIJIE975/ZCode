// ============================================================
// Client Request Signing 密码学原语
// ============================================================
// 与服务端 Client Signing V4 网关协议对齐的密钥推导、握手签名、
// 私钥解密、业务签名与 PoW。纯函数、无进程状态；调用方负责密钥生命周期。
// 常量字符串（salt / info / method）是线上协议的一部分，不能随意改动。

/** HKDF salt：签名密钥族推导的协议级固定盐。 */
const CLIENT_SIGN_KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
/** HKDF info：握手 HMAC 签名密钥。 */
const HANDSHAKE_KEY_INFO = "getSignKey_hmac";
/** HKDF info：Ed25519 私钥解密密钥。 */
const PRIVATE_KEY_INFO = "ed25519_priv";

export interface ParsedClientSigningCredential {
  apiKeyId: string;
  apiKeySecret: string;
  credential: string;
  /**
   * 握手 body 中承载凭据的字段名。发行版 3.15.1 起账号型 Coding Plan 的传输凭据
   * 是 `project_access` JWT，用 `accessToken` 承载；传统 `id.secret` Key 用 `apiKey`。
   */
  handshakeField: "accessToken" | "apiKey";
}

const PROJECT_ACCESS_TOKEN_USE = "project_access";

/**
 * 解析 Client Signing 凭据，与发行版 3.15.1 的 parseClientSigningCredential 对齐，接受两种形态：
 *
 * 1. `project_access` JWT（3 段；头 `{alg:HS256, typ:JWT, sign_type:SIGN}`，
 *    载荷 `{token_use:"project_access", api_key}`）——3.15.1 起账号型 Coding Plan
 *    的传输凭据即此 JWT（由 ProjectAccessTokenClient 现场换取）；`apiKeyId` 取载荷内
 *    `api_key`，签名 secret 是整个 JWT，握手字段为 `accessToken`。
 * 2. `id.secret` 形态（恰好一个分隔符，两侧非空）——传统 Coding Plan API Key。
 *
 * 其余形态（含普通 OpenAI 风格 `sk-xxx`）返回 undefined，由调用方决定降级还是失败。
 * 与发行版一致：3 段且第 3 段非空的串按 JWT 解析，失败即返回 undefined，不再回退 `id.secret` 分支。
 */
export function parseClientSigningCredential(apiKey: string): ParsedClientSigningCredential | undefined {
  const segments = apiKey.split(".");
  if (segments.length === 3 && segments[2]) {
    return parseProjectAccessToken(apiKey);
  }
  const separatorIndex = apiKey.indexOf(".");
  if (
    separatorIndex <= 0 ||
    separatorIndex !== apiKey.lastIndexOf(".") ||
    !apiKey.slice(0, separatorIndex).trim() ||
    !apiKey.slice(separatorIndex + 1).trim()
  ) {
    return undefined;
  }
  return {
    apiKeyId: apiKey.slice(0, separatorIndex),
    apiKeySecret: apiKey.slice(separatorIndex + 1),
    credential: apiKey,
    handshakeField: "apiKey",
  };
}

function parseProjectAccessToken(token: string): ParsedClientSigningCredential | undefined {
  try {
    const [headerSegment, payloadSegment] = token.split(".");
    const header = decodeJwtSegment(headerSegment);
    if (header?.alg !== "HS256" || header.typ !== "JWT" || header.sign_type !== "SIGN") {
      return undefined;
    }
    const payload = decodeJwtSegment(payloadSegment);
    const apiKeyId = payload?.api_key;
    if (
      payload?.token_use !== PROJECT_ACCESS_TOKEN_USE ||
      typeof apiKeyId !== "string" ||
      !apiKeyId.trim()
    ) {
      return undefined;
    }
    return { apiKeyId, apiKeySecret: token, credential: token, handshakeField: "accessToken" };
  } catch {
    return undefined;
  }
}

/** base64url 解码 JWT 段并解析为对象；非对象或解码失败返回 undefined。 */
function decodeJwtSegment(segment: string | undefined): Record<string, unknown> | undefined {
  if (!segment) return undefined;
  const normalized = segment.replace(/-/gu, "+").replace(/_/gu, "/");
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0)),
  );
  const value: unknown = JSON.parse(json);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 用 HKDF 派生的 HMAC-SHA256 密钥对 message 签名，输出 base64。 */
export async function createHandshakeSignature(
  apiKeySecret: string,
  message: string,
): Promise<string> {
  const hmacKey = await deriveBits(apiKeySecret, HANDSHAKE_KEY_INFO);
  try {
    const key = await crypto.subtle.importKey("raw", hmacKey, { hash: "SHA-256", name: "HMAC" }, false, [
      "sign",
    ]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encodeUtf8(message)));
    try {
      return bytesToBase64(signature);
    } finally {
      signature.fill(0);
    }
  } finally {
    hmacKey.fill(0);
  }
}

/**
 * 解密握手下发的 privateCipher 得到 Ed25519 PKCS8 私钥。
 * ciphertext 布局：12B IV + (AES-GCM 密文 + 16B tag)；additionalData 绑定 apiKeyId，
 * 密文被换绑到其它 Key 上会直接解密失败。
 */
export async function decryptSigningPrivateKey(
  apiKeyId: string,
  apiKeySecret: string,
  privateCipher: string,
): Promise<CryptoKey> {
  let aesKeyBytes: Uint8Array<ArrayBuffer> | undefined;
  let plaintextBytes: Uint8Array<ArrayBuffer> | undefined;
  let privateKeyBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const cipherBytes = base64ToBytes(privateCipher);
    if (cipherBytes.byteLength <= 12 + 128 / 8) {
      throw new Error("privateCipher is too short");
    }
    aesKeyBytes = await deriveBits(apiKeySecret, PRIVATE_KEY_INFO);
    const aesKey = await crypto.subtle.importKey("raw", aesKeyBytes, "AES-GCM", false, ["decrypt"]);
    plaintextBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          additionalData: encodeUtf8(apiKeyId),
          iv: cipherBytes.slice(0, 12),
          name: "AES-GCM",
          tagLength: 128,
        },
        aesKey,
        cipherBytes.slice(12),
      ),
    );
    privateKeyBytes = base64ToBytes(new TextDecoder().decode(plaintextBytes));
    return await crypto.subtle.importKey("pkcs8", privateKeyBytes, "Ed25519", false, ["sign"]);
  } finally {
    aesKeyBytes?.fill(0);
    plaintextBytes?.fill(0);
    privateKeyBytes?.fill(0);
  }
}

/** Ed25519 业务签名，输出 base64。 */
export async function signBusinessMessage(key: CryptoKey, message: string): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, encodeUtf8(message)));
  try {
    return bytesToBase64(signature);
  } finally {
    signature.fill(0);
  }
}

export interface ClientRequestProofOfWorkInput {
  apiKeyId: string;
  appId: string;
  powBits: number;
  sessionId: string;
  signal?: AbortSignal;
  ts: string;
}

/**
 * 求解 `SHA-256(apiKeyId\nappId\nsessionId\nts)` 摘要前 16 字节 hex 绑定的
 * 前导零 PoW：salt(12B hex) + counter(4B hex)，返回该拼接串。
 * 上限 2^32 次迭代保证终止；powBits 由协议固定为 8，普通机器毫秒级完成。
 */
export async function createClientRequestProofOfWork(
  input: ClientRequestProofOfWorkInput,
): Promise<string> {
  if (!Number.isInteger(input.powBits) || input.powBits < 0 || input.powBits > 32) {
    throw new Error("powBits must be an integer between 0 and 32");
  }
  input.signal?.throwIfAborted();
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encodeUtf8(`${input.apiKeyId}\n${input.appId}\n${input.sessionId}\n${input.ts}`),
    ),
  );
  const challengePrefix = bytesToHex(digest).slice(0, 32);
  const salt = randomHex(12);
  for (let counter = 0; counter <= 4_294_967_295; counter += 1) {
    input.signal?.throwIfAborted();
    const candidate = `${salt}${counter.toString(16).padStart(8, "0")}`;
    const attempt = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encodeUtf8(`${challengePrefix}\n${candidate}`)),
    );
    if (hasLeadingZeroBits(attempt, input.powBits)) {
      return candidate;
    }
  }
  throw new Error("Unable to solve client request proof of work");
}

/** 生成指定字节数的随机 hex（每字节 2 个字符）。 */
export function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (255 << (8 - remainingBits)) & 255;
  return ((bytes[fullBytes] ?? 255) & mask) === 0;
}

async function deriveBits(secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { hash: "SHA-256", info: encodeUtf8(info), name: "HKDF", salt: encodeUtf8(CLIENT_SIGN_KDF_SALT) },
      key,
      256,
    ),
  );
}

function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("invalid base64");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
