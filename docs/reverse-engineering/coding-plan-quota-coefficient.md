# Coding Plan 额度 0.67 折算系数 · 发行版逆向分析报告

- 分析对象：本机安装的 ZCode 发行版 `D:\Program Files\ZCode`（桌面端 `@zcode/desktop` 3.14.3，CLI 运行时 `resources/glm/zcode.cjs`，来源标注 `apps/zcode-cli/packages/cli/dist/zcode.cjs`）。
- 分析方式：将 `app.asar`（327MB）与 `zcode.cjs`（14.8MB）**复制**到 `E:\reverse-tmp\zcode-analysis` 后解包/检索，安装目录全程只读。
- 对照基线：开源仓库 commit `29628c9`（v3.14.3），工作树 `E:\Personal\ZCode-wt-quota067`，分支 `feat/coding-plan-quota-coefficient`。

## 一、结论

**0.67 系数不在客户端任何代码里。** 在发行版的全部产物（CLI bundle、桌面 main/preload/renderer、i18n 资源）中：

- `0.67` / `.67` / `2/3` / `1.49` / `0.667` 等字面量只出现在 SVG 路径、CSS 类名、framer-motion 颜色计算里，无一与额度相关；
- `折算`、`优惠`、`discount`、`coefficient`、`multiplier` 等词在业务代码中无匹配；
- 客户端所有额度与积分展示都是服务端数值的直通：
  - 套餐额度卡：entitlement 快照 `quota.limits[]`，剩余百分比 = `100 - limit.percentage`（`packages/ui/src/lib/codingPlanQuotaPresentation.ts`，两版一致）；
  - 用量统计「积分消耗/用量消耗」：BigModel `usage-detail` 接口下发的 `totalCredits` / `creditsUsage` 系列（`bigmodelUsageMonitorMapper.ts` 纯映射，两版一致）；
  - 聊天配额横幅：服务端 quota state（`quotaPeriod: daily | one_time`）驱动。

**折算由服务端计费系统应用，触发条件是「请求能通过客户端签名验证」。** 发行版客户端比开源版多出一整套 **Client Request Signing V4**：给官方 Coding Plan 的模型请求附加 `X-Client-*` 签名 header 族，网关验签通过（`X-Client-Sign-Verified`）即按官方 ZCode 渠道计费——这正是「在 ZCode 中通过 Coding Plan 调用模型，额度消耗全周期按 0.67 系数折算（≈150% 额度权益）」的实现方式。开源版 29628c9 完全没有这套模块（`codingPlanSignature`、`clientRequestSigningState`、`signingManager` 等标识符在开源源码中零匹配）。

## 二、发行版签名体系还原（自 minified bundle）

### 2.1 组成

| 组件（minified 名）                          | 职责                                                       |
| -------------------------------------------- | ---------------------------------------------------------- |
| `oHo` createRuntimeAiSdkModelExecutionConfig | 运行时配置新增 `codingPlanSignature: {configUrl, headers}` |
| `aPe` CodingPlanSignatureFeatureGate         | 查询服务端是否启用签名，1h 缓存                            |
| `lPe` ClientRequestSigningV4Manager          | 按 providerId 管理 signer 实例                             |
| `KJt` ClientRequestSigningV4Signer           | 单请求签名流程（gate→握手→签名→验签重试→降级）             |
| `cPe` ClientRequestSigningV4KeyCache         | 按 (apiKey, origin) 复用私钥                               |
| `S2it/Fit` AiSdkClientRequestSigningState    | 跨 Execution 共享 gate/私钥（CLI 内未实例化，供宿主注入）  |
| `Dit` ClientSigningObservationStore          | 按 `x-request-id` 归因的观测环形记录（64 条）              |

### 2.2 触发条件（`cRs` requiresClientRequestSigning）

access 满足任一即签名：

1. `zhipu-coding-plan-api-key`（Coding Plan 专用 API Key）；
2. `zhipu-account` 且 mode 为 `individual-coding-plan` / `team-coding-plan`；
3. baseURL 主机命中官方根域 `z.ai` / `bigmodel.cn`（含子域）；
4. baseURL 主机 ∈ {`api.chatglm.site`, `zcode.chatglm.site`}。

`start-plan` / `off-peak` 账号模式明确排除；若此时 baseURL 是官方域，走 `createAccessModeUnsignedFetch`：照常发送但记录 `unsigned_sent(access_mode)` 观测。

### 2.3 单请求流程（Signer.request）

```
fetch(input, init)
 → makeReplayableSigningRequest（body 读出为字节数组，可重发）
 → origin ≠ provider baseURL origin → 未签名发送("origin_mismatch")
 → signer 处于 bypass → 未签名发送("bypass")
 → feature gate（GET {zcodeEndpoint}/api/v1/agent/configs，头 = 平台来源头 + x-api-key）
     关闭  → 未签名发送("feature_gate_disabled")
     异常  → 未签名发送("feature_gate_unavailable")
 → 私钥（keyCache 命中或握手）：
     POST {providerOrigin}/api/paas/c1f3a7e2/v2/client
     body {apiKey, nonce, sig, ts}；sig = HMAC-SHA256(HKDF(apiKeySecret, salt="WD_CLIENT_SIGN_KDF_SALT",
     info="getSignKey_hmac")) over "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"
     响应 {code:200, data:{privateCipher}} → AES-GCM(HKDF info="ed25519_priv", AD=apiKeyId,
     12B IV + 密文/tag) 解出 PKCS8 Ed25519 私钥
     可恢复失败（网络/超时/协议/业务码，failOpenEligible）→ 未签名发送("handshake_failed")
     其它（invalid-config / cryptography / disposed）→ 抛出（fail-closed）
 → 签名发送：X-App-Id: zcode、X-Client-Ts、X-Client-Version、X-Client-Nonce(16B hex)、
     X-Client-Sig = base64(Ed25519("apiKeyId\nts\nversion\nsessionId\nnonce"))、
     X-Client-Pow = SHA-256 前导 8bit 零 PoW（challenge = SHA-256("apiKeyId\nzcode\nsessionId\nts")
     前 16B hex；candidate = salt12B hex + counter4B hex）
 → 响应 401 且 msg/reason ∈ {VERIFY_SIGNATURE_INVALID, VERIFY_APIKEY_EXPIRED}
     → 私钥失效 → 重新握手 → 重签重发一次
     → 仍被拒 → 进入 bypass，本次及本 signer 后续请求未签名("verify_refresh_exhausted")
```

其它要点：

- `apiKey` 必须是 `id.secret` 形态（恰好一个 `.` 分隔、两侧非空），否则发送前抛 `invalid-config`；
- 每次发送前剥离请求上既有签名 header（含网关回显的 `X-Client-Sign-Verified`）；
- 签名要求请求已带 `X-Session-Id`（模型请求归因 header 族本来就有）；
- 握手 10s 超时、gate 15s 超时；manager 按 (providerId, apiKey, baseURL, clientVersion, transport) 复用/重建 signer；
- 观测日志事件：`model.client_signing.signed_sent / unsigned_sent / handshake_failed / verify_rejected / bypass_entered / request_failed_closed / feature_gate`；另经 statusSink 发布 `model_client_signing` 事件。

### 2.4 与额度折算的关系

签名请求经官方网关（开源版中官方 Coding Plan 端点被改写到 `zcode.z.ai/api/v1/ultra[-zai]/anthropic/v1/messages`；发行版改由宿主端点路由决定）转发到模型服务。网关验签通过即标记该请求来自正版 ZCode 客户端，服务端计费对该请求的额度消耗按 0.67 记账（等价于约 1.49 倍额度权益，产品宣传取整为 150%）。未签名请求按 1.0 计量。客户端不做任何折算运算，只负责让请求「可被验签」。

## 三、开源版差异面（29628c9）

| 位置           | 发行版有                                                 | 开源版                         |
| -------------- | -------------------------------------------------------- | ------------------------------ |
| 运行时配置     | `codingPlanSignature {configUrl, headers}`               | 无                             |
| adapters/model | 签名模块（gate/握手/签名/降级）+ `signingManager` 装配   | 无，fetch 链为 网关改写 → 代理 |
| 请求头         | Coding Plan 请求带 `X-Client-*` 7 头                     | 无                             |
| 观测           | `model.client_signing.*` 日志 + 请求级 observation store | 无                             |
| 适配器选项     | `clientRequestSigningState` 共享状态透传                 | 无                             |

其余（归因 header `x-request-id`/`x-session-id`、代理 fetch、业务错误 fetch、网关改写）两版一致，移植面收敛在 adapters + bootstrap 两处。

## 四、移植实现（本分支）

1. `apps/zcode-cli/packages/adapters/src/model/client-request-signing-crypto.ts`（新增）：HKDF 派生、握手 HMAC、AES-GCM 私钥解密、Ed25519 业务签名、PoW、`id.secret` 凭据解析。协议常量与发行版逐字对齐。
2. `apps/zcode-cli/packages/adapters/src/model/client-request-signing.ts`（新增）：feature gate（`/api/v1/agent/configs` → `data.codingPlanSignature.enable`，1h/15s）、keyCache、manager、signer（origin/bypass/gate/握手/验签重试/降级）、observation store、共享状态类、错误分类（fail-open vs fail-closed）。
3. `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`：`AiSdkModelExecutionConfig.codingPlanSignature`、`AiSdkModelExecutionOptions.clientRequestSigningState`、`AiSdkResolvedModel.clientSigningObservations`；`createFactory` 按 `requiresClientRequestSigning` 包装签名 fetch，官方域免签 access 走 access-mode 观测；日志事件对齐发行版。
4. `apps/zcode-cli/packages/adapters/src/model/runner.ts`：`AiSdkModelAdapterOptions` 透传上述两项。
5. `apps/zcode-cli/packages/bootstrap/src/model-config.ts`：`createRuntimeAiSdkModelExecutionConfig` 产出 `codingPlanSignature`（configUrl 跟随 `ZCODE_BASE_URL`/`ZCODE_ENDPOINT_ORIGIN`，默认 `https://zcode.z.ai`；headers 复用 CLI 来源头）。
6. `docs/specs/client-request-signing.md`：行为 spec（状态所有者、事件顺序、验收场景）。

有意收敛的差异：发行版还会把观测经 statusSink 发布为 `model_client_signing` 状态事件；该事件类型横跨 contracts/bootstrap/core/telemetry/tui/shared 的协议面（约 7 个包的 exhaustive 消费点），本分支只保留 logger 事件与 observation store，行为不受影响，待需要接入桌面端观测面板时再扩展协议。

## 五、验证

- `apps/zcode-cli/packages/adapters`：`tsc --noEmit` 通过（依赖 contracts/dynamic-workflow 先行构建）。
- `apps/zcode-cli/packages/bootstrap`：`tsc --noEmit` 通过（依赖闭包先行构建）。
- oxlint：全部新增/修改文件 0 warning 0 error；两包存量 lint 报错位于本次未触碰的文件（`src/mcp/index.ts`、`product-projection.ts` 等），为 29628c9 基线已有。
- oxfmt：通过。
- 行为冒烟（mock transport，见 `E:\reverse-tmp\zcode-analysis\signing-smoke.mjs`）：gate 关闭→透传未签名；gate 开启+mock 握手→请求带全量 `X-Client-*` 头且 PoW/签名可复验；401 验签被拒→重新握手重发→再拒进入 bypass；`requiresClientRequestSigning` 判定矩阵与发行版一致。

## 六、风险与边界

- 私钥握手与 gate 均为网络新增调用，只在命中签名条件的 provider 上发生；失败路径全部 fail-open（未签名发送），不影响可用性。
- 折算比例本身（0.67）与服务端 gate 开关（`codingPlanSignature.enable`）由服务端控制，客户端无法也不应本地配置。
- `apiKey` 非 `id.secret` 形态且 gate 开启时会 fail-closed——与发行版一致（普通 `sk-` Key 的 provider 通常不在官方域，不会进入签名分支）。
