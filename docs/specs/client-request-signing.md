# Client Request Signing（Coding Plan 客户端请求签名）Spec

## 背景与目标

官方发行版中，通过 Coding Plan 调用模型时额度消耗全周期按 0.67 系数折算（约 150% 额度权益）。
逆向发行版确认：**0.67 折算系数完全由服务端计费系统应用**，客户端（CLI 运行时与桌面端）
不包含任何系数常量，也不参与额度数值计算。客户端的职责是携带一套可被网关验签的请求签名，
让服务端能区分「来自正版 ZCode 客户端的 Coding Plan 请求」，并据此应用折算计费。

开源版缺少整套签名模块。本 spec 定义把它补齐后的客户端行为边界。

## 产品规则

1. 签名只作用于官方 Coding Plan 链路；第三方 provider、start-plan、off-peak 不签名。
2. 签名对请求体透明：不改变 URL、方法、鉴权头与请求体，只追加 `X-Client-*` 一族 header。
3. 签名失败不得破坏可用性：feature gate 关闭 / 握手可恢复失败 / 验签两次被拒 → 按未签名请求继续发送（降级），并记录观测事件；仅非法配置、密码学异常等不可恢复错误允许抛出（fail-closed）。
4. 折算系数、额度、积分的数值一律以服务端下发为准；客户端不得本地计算或改写任何额度数值。
5. **进入签名层的 provider 直连注册表下发的 baseURL**（含降级后的未签名请求），不做开源版
   `/api/v1/ultra*` 网关端点改写——发行版 3.14.3 即此行为（其动态 `proxyEndpoint` 映射当前为空），
   签名头由 bigmodel/z.ai 端点侧校验计费；网关改写只保留给非签名链路。

## 状态所有者

| 状态                         | 所有者                                     | 生命周期                                     |
| ---------------------------- | ------------------------------------------ | -------------------------------------------- |
| feature gate 快照（enable）  | `CodingPlanSignatureFeatureGate`           | 1h TTL，进程内                               |
| Ed25519 私钥 / 握手 Promise  | `ClientRequestSigningKeyState`（keyCache） | 进程内，验签被拒即失效                       |
| signer 实例（含 bypass 位）  | `ClientRequestSigningManager`              | 按 providerId，apiKey/baseURL/版本变更即重建 |
| 请求级观测记录               | `ClientSigningObservationStore`            | 64 个 requestId 的环形记录                   |
| 共享签名状态（跨 Execution） | `AiSdkClientRequestSigningState`（可选）   | 由宿主注入；缺省各 Execution 独立缓存        |

## 接口

### 运行时配置（bootstrap → adapters）

```ts
interface CodingPlanSignatureRuntimeConfig {
  configUrl: string | (() => string); // {zcodeEndpoint}/api/v1/agent/configs
  headers: Record<string, string> | (() => Record<string, string>); // 平台来源头 + x-api-key
}
```

`createRuntimeAiSdkModelExecutionConfig` 产出 `codingPlanSignature` 字段，
随 `AiSdkModelExecutionConfig` 进入 `AiSdkModelExecution`。

### 触发条件（requiresClientRequestSigning）

满足其一即签名：

- access 为 `zhipu-coding-plan-api-key`；
- access 为 `zhipu-account` 且 mode ∈ {`individual-coding-plan`, `team-coding-plan`}；
- baseURL 主机命中官方域（`z.ai` / `bigmodel.cn` 根域及子域）；
- baseURL 主机 ∈ {`api.chatglm.site`, `zcode.chatglm.site`}。

access 为 `zhipu-account` 且 mode ∈ {`start-plan`, `off-peak`} 时明确不签名；
若此时 baseURL 命中官方域，发送未签名请求并记录 `unsigned_sent(access_mode)` 观测。

### 请求流程（事件顺序）

```
fetch(input, init)
  → 还原可重放请求（body 读出为 Uint8Array）
  → origin 与 provider baseURL 不一致 → unsigned("origin_mismatch")
  → signer 已 bypass → unsigned("bypass")
  → feature gate（1h 缓存；关闭 → unsigned("feature_gate_disabled")；异常 → unsigned("feature_gate_unavailable")）
  → 取私钥（keyCache → 握手 POST {origin}/api/paas/c1f3a7e2/v2/client）
      可恢复失败 → unsigned("handshake_failed")；其它异常 → 抛出（fail-closed）
  → 发送签名请求（PoW + Ed25519 → X-Client-* headers）
  → 401 且 VERIFY_SIGNATURE_INVALID / VERIFY_APIKEY_EXPIRED
      → 私钥失效 → 重新握手 → 重签重发一次
      → 仍被拒 → 进入 bypass → unsigned("verify_refresh_exhausted")
```

### 服务端验签的客户端证据

网关**不**回显 `x-client-sign-verified`（实测响应头无此头；协议保留该名仅出现在出站剥离列表）。
因此客户端侧的验签通过证据链是：`signed_sent(轮次1)` + 该请求 HTTP 200 完成 +
无 `verify_rejected`/`bypass_entered` 观测——若签名被拒，signer 会自动重签重发并记录
`verify_rejected`，连续两次被拒才进入 bypass 并显示「未签名(verify_refresh_exhausted)」。

### 签名 header 一族

`X-App-Id: zcode`、`X-Client-Ts`、`X-Client-Version`、`X-Client-Nonce`（16B hex）、
`X-Client-Sig`（Ed25519(apiKeyId\nts\nversion\nsessionId\nnonce)）、
`X-Client-Pow`（SHA-256 前导 8 bit 零的 PoW）。
每次发送前剥离请求上既有的签名 header（含网关回显的 `X-Client-Sign-Verified`），防止过期值透传。

### 观测

- logger 事件：`model.client_signing.signed_sent / unsigned_sent / handshake_failed / verify_rejected / bypass_entered / request_failed_closed / feature_gate`。
- `ClientSigningObservationStore` 以 `x-request-id` 归因每条观测，随 resolved model 暴露。
- `signed_sent` 观测附带本请求签名头全量取值（x-app-id/ts/version/nonce/sig/pow/session-id），
  面板「签名头」区块完整展示（用户明确要求不脱敏；取值逐请求变化，非长期凭据，不含 apiKey）。
- runner 在每次尝试收口（completed / failed）后把观测发布为 `model_client_signing` 状态事件
  （投 requestStatusSink 驱动应用内可视化 + 进程级 statusSink 对齐发行版观测面；不投
  admissionTicket）：经 core 记为 SessionEvent 后进入会话调试快照，签名观测按 requestId
  **并入同一请求的最新网络条目**（不单独成行；找不到对应条目时兜底独立成行），最终在
  桌面端「开发者工具」面板网络区的请求条目内展示签名结论与签名头。空 header 区块
  （如请求开始条目的 Response Headers）不渲染。v4 telemetry fact、TUI 网络列表与对话投影
  显式忽略该事件类型。

## 验收场景

1. Coding Plan API key 请求：gate 开启 → 请求带 7 个签名 header，日志出现 `signed_sent`。
2. gate 关闭（`codingPlanSignature.enable !== true`）：请求不签名，日志 `feature_gate disabled`。
3. 握手网络失败：请求不签名继续发送，日志 `handshake_failed`（warn），不抛出。
4. 首次 401 验签被拒：自动重新握手并重发；再被拒进入 bypass，本 signer 后续请求不签名。
5. start-plan/off-peak + 官方域：不签名，观测记录 `access_mode`。
6. 第三方 provider（非官方域）：不包装 signer，行为与现状一致。
7. `apiKey` 不是 `id.secret` 形态：握手段抛 `invalid-config`（fail-closed）。
8. 桌面端左侧一级菜单新增「开发者工具」按钮（插件市场下方，`data-testid="developer-tools-sidebar-open"`），
   点击直接打开右侧面板的开发者工具 tab；右侧「+」菜单入口默认显示（显式写入
   `zcode:developer-tools:enabled=0/false/off/no` 才隐藏）；Coding Plan 请求在网络区
   伴随出现「客户端签名」条目：正常链路显示「已签名发送」。
9. 会话统计信息条（输入框上方常驻，`data-testid="session-stats-bar"`）展示轮数/步数/
   上一轮与平均 tps/输入/输出/缓存读/命中率，右侧附签名状态徽标
   （`data-testid="session-stats-signing-badge"`；原侧边栏底部徽标已移除）：
   - live 数据来自 session-debug 快照（处理中 1s 刷新、空闲 5s）；快照新增
     `latestClientSigning` 旁路指针，不随 networkEntries 窗口滑出而丢失。
   - 持久数据来自 `v4/conversation/usage`（SQLite `model_usage`/`turn_usage` 聚合，
     保留 30 天）：`turnCount`/`toolCallCount`/`lastRoundTokensPerSecond`/
     `averageTokensPerSecond`/`mainTurn{Input,Output,CacheRead}Tokens`/
     `lastClientSigning`。应用重启后打开历史会话仍能展示（轮/步/tps/累计/签名状态）。
   - 签名结论随每次模型请求落库（`model_usage.client_signing_kind/reason`，
     migration 0023），只存 kind/reason，签名头取值不落盘、不出远端流。
10. 非法凭据（非 `id.secret` 形态且 gate 开启）：降级为未签名发送并记
    `unsigned_sent(invalid_credential)`——官方域上用户自建 provider + 普通 `sk-` Key
    的按量 API 用法不得被签名层硬失败（对发行版 fail-closed 语义的开源侧偏差，
    属可用性修正）。
11. gate 查询失败启用 30s 负缓存：端点故障期不再逐请求付出 15s gate 超时；
    成功结论仍按 1h TTL 缓存（对发行版语义的开源侧可用性增补）。
