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

其余（归因 header `x-request-id`/`x-session-id`、代理 fetch、业务错误 fetch）两版一致。网关改写**不一致**：开源版固定叠加 `/api/v1/ultra*` 网关路由，发行版没有该硬编码（其动态 `proxyEndpoint` 当前为空，见第七节 7.2），本分支已按发行版语义修正为签名链路直连。

## 四、移植实现（本分支）

1. `apps/zcode-cli/packages/adapters/src/model/client-request-signing-crypto.ts`（新增）：HKDF 派生、握手 HMAC、AES-GCM 私钥解密、Ed25519 业务签名、PoW、`id.secret` 凭据解析。协议常量与发行版逐字对齐。
2. `apps/zcode-cli/packages/adapters/src/model/client-request-signing.ts`（新增）：feature gate（`/api/v1/agent/configs` → `data.codingPlanSignature.enable`，1h/15s）、keyCache、manager、signer（origin/bypass/gate/握手/验签重试/降级）、observation store、共享状态类、错误分类（fail-open vs fail-closed）。
3. `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`：`AiSdkModelExecutionConfig.codingPlanSignature`、`AiSdkModelExecutionOptions.clientRequestSigningState`、`AiSdkResolvedModel.clientSigningObservations`；`createFactory` 按 `requiresClientRequestSigning` 包装签名 fetch，官方域免签 access 走 access-mode 观测；日志事件对齐发行版。
4. `apps/zcode-cli/packages/adapters/src/model/runner.ts`：`AiSdkModelAdapterOptions` 透传上述两项。
5. `apps/zcode-cli/packages/bootstrap/src/model-config.ts`：`createRuntimeAiSdkModelExecutionConfig` 产出 `codingPlanSignature`（configUrl 跟随 `ZCODE_BASE_URL`/`ZCODE_ENDPOINT_ORIGIN`，默认 `https://zcode.z.ai`；headers 复用 CLI 来源头）。
6. `docs/specs/client-request-signing.md`：行为 spec（状态所有者、事件顺序、验收场景）。

`model_client_signing` 状态事件已全链路补齐（第二笔提交）：contracts 事件类型与 JSON schema、
adapters runner 发布（generate/stream 收口时）、shared 调试状态映射与 session-debug schema、
core 日志、v4 facts/projection 与 TUI 的显式忽略、桌面端开发者工具面板网络区展示
（签名结论 + 原因 + 轮次，`data-testid="developer-tools-signing-kind"`）、
中英文案。开启方式：localStorage `zcode:developer-tools:enabled=1` 后从侧边栏「+」打开。

## 五、验证

- `apps/zcode-cli/packages/adapters`：`tsc --noEmit` 通过（依赖 contracts/dynamic-workflow 先行构建）。
- `apps/zcode-cli/packages/bootstrap`：`tsc --noEmit` 通过（依赖闭包先行构建）。
- oxlint：全部新增/修改文件 0 warning 0 error；两包存量 lint 报错位于本次未触碰的文件（`src/mcp/index.ts`、`product-projection.ts` 等），为 29628c9 基线已有。
- oxfmt：通过。
- 行为冒烟（mock transport，见 `E:\reverse-tmp\zcode-analysis\signing-smoke.mjs`）：gate 关闭→透传未签名；gate 开启+mock 握手→请求带全量 `X-Client-*` 头且 PoW/签名可复验；401 验签被拒→重新握手重发→再拒进入 bypass；`requiresClientRequestSigning` 判定矩阵与发行版一致。

## 六、风险与边界

- 私钥握手与 gate 均为网络新增调用，只在命中签名条件的 provider 上发生；失败路径全部 fail-open（未签名发送），不影响可用性。
- 折算比例本身（0.67）与服务端 gate 开关（`codingPlanSignature.enable`）由服务端控制，客户端无法也不应本地配置。
- `apiKey` 非 `id.secret` 形态且 gate 开启时降级 `unsigned_sent(invalid_credential)` 继续发送（第八轮审查后的现行行为；普通 `sk-` Key 的按量 provider 不受影响）。

## 七、第八轮复核：路由偏差修正与全量逐项重核（2026-09-28）

应用户要求对移植做一轮「不信结论文档、直接对 bundle 重新取证」的复核。全部关键常量、
canonical 串与流程重新从 `zcode.cjs` 提取核对，同时发现并修正一个实质性路由偏差。

### 7.1 逐项重核结论（全部对上）

| 项目                | 发行版（bundle 取证）                                                                                                                                                       | 移植实现                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| HKDF                | SHA-256，salt `WD_CLIENT_SIGN_KDF_SALT`，info `getSignKey_hmac`/`ed25519_priv`，256bit                                                                                      | 一致                                                                       |
| 握手签名串          | `get_sign_key\n{apiKeyId}\n{ts}\n{nonce}`                                                                                                                                   | 一致                                                                       |
| privateCipher       | base64，12B IV + AES-GCM(128tag)，AD=apiKeyId，PKCS8 Ed25519                                                                                                                | 一致                                                                       |
| 业务签名串          | `{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}`（**不覆盖 method/path/body**）                                                                                    | 一致                                                                       |
| PoW                 | challenge=SHA-256(`apiKeyId\nappId\nsessionId\nts`) hex 前 32 字符；salt 12B hex + counter 4B hex；前导 8 bit 零                                                            | 一致                                                                       |
| 7 个签名头 + 剥离集 | Ts/Version/Sig/Nonce/Pow/App-Id + Sign-Verified 回显位                                                                                                                      | 一致                                                                       |
| gate                | `{origin}/api/v1/agent/configs`，code!==0 不缓存，缺 `codingPlanSignature` 键视为关闭并缓存，TTL 1h/超时 15s                                                                | 一致                                                                       |
| 握手                | POST `{baseURL origin}/api/paas/c1f3a7e2/v2/client`，body `{apiKey,nonce,sig,ts}`，Authorization=完整凭据，10s 超时；code 500 / 非 200 / 缺 cipher 各自分类，全部 fail-open | 一致                                                                       |
| 验签被拒            | 仅 401 且 msg/reason/data.reason/error.reason/error.message 命中 `VERIFY_SIGNATURE_INVALID`/`VERIFY_APIKEY_EXPIRED`；重握手重签一次，再拒进 bypass                          | 一致                                                                       |
| 触发矩阵            | start-plan/off-peak 排除；coding-plan-api-key；账号型个人/团队；`z.ai`/`bigmodel.cn` 根域；`api.chatglm.site`/`zcode.chatglm.site`                                          | 一致                                                                       |
| clientVersion       | 头 `X-ZCode-App-Version` 优先，回退 `__ZCODE_VERSION__ ?? "0.0.0-dev"`                                                                                                      | 一致（本轮把回退改为共享 `ZCODE_VERSION` 常量）                            |
| 观测发布            | `publishClientSigningObservations` 在 `publishModelStatus` 内部、主事件扇出前，逐条 `{...完成事件, observation, type:"model_client_signing"}` 只投 runner `statusSink`      | 机制一致；移植额外投 requestStatusSink 以驱动应用内可视化（发行版无该 UI） |

### 7.2 发现的路由偏差（本轮修正）

发行版 3.14.3 bundle 中**不存在**开源版的 `/api/v1/ultra`、`/api/v1/ultra-zai` 硬编码
网关路由（全 bundle 零命中）。发行版的真实路由机制是：

- 内置 provider 注册表运行时下发（`GET {origin}/api/v1/client/configs?app_version=&platform=`
  → `data.configs.builtin_provider_config_json` → CDN）。当前 rev23 实测：
  - `account:bigmodel-individual-coding-plan` → `https://open.bigmodel.cn/api/anthropic`
  - `account:zai-individual-coding-plan` → `https://api.z.ai/api/anthropic`
  - start-plan（zai/bigmodel）→ `https://zcode.z.ai/api/v1/zcode-plan/anthropic`
- 另有动态端点改写 `ProviderEndpointRoutingService`：同一 `/api/v1/agent/configs` 的
  `data.proxyEndpoint.mapping[{from,to}]`（成功缓存 5 分钟、失败退避 30 秒、3 秒超时）。
  **实测当前响应无 `proxyEndpoint` 字段 → 映射为空 → 发行版不改写任何端点。**

即发行版的签名请求（含 gate 关闭后的未签名降级）**直连注册表 baseURL**（如
`https://open.bigmodel.cn/api/anthropic/v1/messages`），签名头由端点侧校验计费。
而开源版 fetch 链固定叠加 ultra 网关改写——此前移植把「签名 + ultra 改写」叠加，
签名虽随请求发出且未被拒，但计费路径与发行版不一致，0.67 系数是否在该网关侧生效
无法从客户端证明。

**修正**（本分支）：进入签名层的 provider 改用直连出口（仅用户 HTTP 代理，不做 ultra
改写），与发行版行为对齐；非签名链路维持开源版 ultra 网关行为不变。握手本就按原始
baseURL origin 发起（`open.bigmodel.cn`），不受影响。

### 7.3 服务端现状实测（2026-09-28）

- `GET https://zcode.z.ai/api/v1/agent/configs`（无鉴权）→
  `{"code":0,"data":{"codingPlanSignature":{"enable":true}}}`：gate 当前开启，
  且当前无 `proxyEndpoint` 下发。
- 用户实测（个人 Coding Plan，`account:bigmodel-individual-coding-plan`）：握手成功、
  `signed_sent` 轮次 1、HTTP 200、无 verify_rejected/bypass 观测——客户端侧全链路通。
- 0.67 折算的业务确认仍需服务端侧证据（使用统计/余额对比），客户端可证的边界到此为止。

## 八、派发审查与修复记录（2026-09-28 第二轮）

三个并行审查（两份独立遗留问题审查 + 一份数据源/持久化调查）交叉验证，合并修复：

**P1 修复**

- 官方域自定义 provider + 普通 `sk-` Key：发行版矩阵会 fail-closed（硬失败）。
  开源版允许该配置（按量 API），现降级 `unsigned_sent(invalid_credential)` 继续发送。
- 签名观测收口补全：空 completion 重试（generate/stream）、chunk 级错误重试、
  `emittedError` 提前返回、`TerminalStreamChunkError` rethrow、consumer 提前关闭的
  cancelled 收口——这些路径原本跳过发布，观测滞留 store 且网络条目无签名结论；
  均已补 `publishClientSigningObservations`（take 幂等）。
- 仓内单测：`apps/zcode-cli/packages/adapters/test/client-request-signing.test.ts`
  9 组（凭据解析、观测 store 环形淘汰、PoW 可验证性、gate 负缓存、gate 关闭、
  签名 7 头 + requestUrl、401→重握手→bypass 时序、invalid_credential、判定矩阵）。

**P2 修复**

- gate 失败 30s 负缓存（故障期延迟放大）；`latestClientSigning` 旁路指针
  （徽标不再随网络条目窗口滑出而消失）；`requestUrl` 观测（应用内可核验直连端点）；
  scope key 对函数型 configUrl/headers 先归一化；signer 复用比较用 trim 后版本；
  删除「网关验签回显」死特性（实测网关不回显）；非 https 官方域构造期抛错改为
  降级直连并告警；重复 requestId 读取实现合并；签名头取值不进持久化与远端广播面
  （落库只存 kind/reason）；tooltip 措辞与实测证据链对齐。
- 徽标 1Hz 常驻轮询收敛：会话统计条处理中 1s / 空闲 5s 刷新。

**已知保留偏差（记录不修）**

- dispose 死代码（发行版同样无宿主挂钩）；共享 signing state（`AiSdkClientRequestSigningState`）
  设计就绪但未接线（与发行版 CLI 一致）；usage 表 30 天保留期外的历史会话统计条
  显示空；企业自建 `ZCODE_BASE_URL` 网关不再截获签名流量（直连是与发行版对齐的目的本身）。

**会话统计信息条（新特性，同轮交付）**

- 服务端：`queryTaskUsage` 扩展（turn/toolCall 计数、main_turn 口径 tps 与原始累计、
  最近签名结论）；`v4/conversation/usage` 与 `session/usage` schema 同步扩字段。
- UI：`SessionStatsBar` 置于输入框上方（与 Quota/Queue 横幅同一 bottom dock），
  live（session-debug）+ 持久（conversationUsage）双源合成；冷启动历史会话由
  持久数据补位。签名徽标从侧边栏底部迁入信息条。

## 八、Start Plan 的 3007「captcha verify failed」（Trust Build 套餐门禁）

### 现象

开源版用 Start Plan 发消息直接失败：`provider_code=3007 reason=auth_failed status=400`，
错误体 `captcha verify failed`，请求 URL `https://zcode.z.ai/api/v1/zcode-plan/anthropic`。
同一账号在官方发行版上正常。控制台 billing/balance 返回的套餐名为
**`zcode-v3-start-plan-trust-0928`（"ZCode Trust Build"）**——服务端侧该套餐绑定
官方可信构建，模型请求经网关反滥用校验（阿里云验证码）后才放行。

### 发行版完整流程（自 bundle 还原）

```
模型请求（start-plan，经 zcode-plan 网关）
 → 网关返回 3007 / captcha verify failed
 → CaptchaRequestRetry.claim()：仅当 access 为 zhipu-account 且 mode=start-plan、
   请求带 refreshRuntimeHeadersBeforeAttempt（账号型模型）、且该请求未用过重试机会
   → 占用一次额外物理尝试（不占普通 retry 预算）
 → 重试前调用 refreshRuntimeHeadersBeforeAttempt({reason:"captcha-retry"})：
   Host 侧弹阿里云验证码（渲染端加载 https://o.alicdn.com/captcha-frontend/
   aliyunCaptcha/AliyunCaptcha.js，结果含 captchaVerifyParam / certifyId，
   支持 region），人机通过后返回请求头：
   X-Aliyun-Captcha-Verify-Param + X-Aliyun-Captcha-Verify-Region
 → 携带验证参数重发一次；验证参数在日志/调试面中被脱敏
（sanitize 集合含 x-aliyun-captcha-verify-param / x-client-sig / x-client-pow）
 → 错误码 coding_plan_security_verification_required 与该流程配套；
   UI 文案：chat.error.action.retryCaptcha / chat.captcha.verifyFailed /
   「验证码未完成导致无内容，重新发送会先运行验证码」
```

要点：这是**人机验证**而非静默签名——需要真人过验证码；发行版也不对
start-plan 请求做 Client Request Signing（`requiresClientRequestSigning` 显式排除）。
开源版 3007 直接报错的原因是缺少整套验证码 UI 与 captcha-retry 重试链路。

### 移植所需（未包含在本分支）

渲染端验证码弹层组件（AliyunCaptcha SDK 加载、按钮锚点、abort/超时层级）、
Host 侧 captcha-retry 的 runtime headers 刷新协议（reason 枚举扩展）、
`CaptchaRequestRetry` 单次额外尝试语义、3007 失败分类调整。属于独立的
跨包特性（renderer + services/host + adapters），需要单独排期实现。

### 3.14.4 后续（2026-09-29）：模型请求验证码门禁被关闭

更新日志「关闭模型请求验证码校验」的落地方式，自 3.14.4 bundle 还原（方法同前：
安装目录只读，asar / glm 复制到临时目录后 diff）：

**服务端**（`GET /api/v1/client/configs` 实测）：

```json
"captcha": { "enabled": true, "prefix": "…", "region": "cn",
             "sceneId": "…", "skip_model_request": true }
```

网关不再对 Start Plan 模型请求强制验证码头——开源版（从未有 captcha 链路）
现可直用 Start Plan，即服务端放行的直接证据。

**客户端 3.14.4 三处配合改动**（全量字面量差分确证无其它逻辑变化）：

1. host `getCaptchaConfig()`：把下发的 `skip_model_request` 规范化为
   `skipModelRequest` 暴露给渲染端（host/index.js 唯一逻辑差异，+105 字节）。
2. 渲染端验证码头刷新入口：新增短路
   `captcha.enabled===false || captcha.skipModelRequest===true → {headers:{}}`，
   不再弹阿里云验证码、不再因配置缺失抛错（渲染端唯一逻辑差异）。
3. CLI `applyModelRequestAuth`：合并请求鉴权时剥离残留的
   `x-aliyun-captcha-verify-param/-region` 头，防旧验证参数复用
   （zcode.cjs 唯一逻辑差异，+149 字节）。

**与本分支的关系**：签名链路（KDF 常量、握手路径、`codingPlanSignature` 配置、
`requiresClientRequestSigning`）在 3.14.4 中逐字节同位、零改动，移植仍对齐。
billing/claim 的验证码（套餐领取）路径也逐字节未动——关闭的只有模型请求这一处。
开源版与 3.14.4 的行为差异仅在服务端重新开启 `skip_model_request=false` 时显现：
3.14.4 会弹验证码并携带头重试，开源版回到 3007 报错。captcha 链路移植与否
由此从「补齐功能」降级为「对冲服务端策略回摆」，优先级自定。

### captcha 链路移植完成（2026-09-30）

按 §八 3.14.4 后续的评估开工并完成（spec：`docs/specs/start-plan-captcha.md`）：

- **CLI**：`CaptchaRequestRetry`（claim 条件矩阵与发行版逐字对齐）接入 generate/stream
  重试循环；openai-compatible 空流合成 3007；`applyModelRequestAuth` 剥残留验证码头；
  sanitize 集合补 `x-aliyun-captcha-verify-param`（顺带补齐 `x-client-sig/pow`）。
- **Host**：skip 判定（`enabled=false`/`skipModelRequest=true` → 纯账号鉴权应答）；
  需要验证经 `captchaVerificationPort` 索取参数并合并进鉴权头；配置缺失/端口缺失
  显式失败（不静默放行）。配置解析 60s TTL + in-flight 去重 + 失败不缓存（f3 语义）。
- **桌面桥**：host → main（parentPort）→ renderer（`CaptchaVerifyRequested`）→
  AliyunCaptcha → 回执（`CaptchaVerifyResult`）→ main 按发起 host 进程路由回执。
- **渲染端**：SDK 加载（memoized+重试）、控制器生命周期（configKey 复用 20min TTL、
  init 串行 drain）、fail 回调状态机（终态通过藏在 fail / F008 复位 / 无感升交互）、
  验证执行（无感优先、120s 总时限、deferred-success 跳过超时）、certifyId 防重复告警；
  `StartPlanCaptchaHost` 挂 Root Provider 树，仅 desktop 平台订阅。
- **验证**：单测 11 组（claim 矩阵/时序/空流合成/配置解析/协议枚举）+ 端到端冒烟
  （3007→captcha-retry→成功恰 2 次尝试、耗尽上抛、非 start-plan 不领取）+
  `pnpm typecheck` 全仓过、lint 0 error（71 warning 为基线）、architecture check 0 违规。
- 与发行版的已知差异：skip 判定在 Host 而非渲染端（行为等价）；3007 错误卡片的
  「重试」按钮未做（错误语义与发行版一致，按钮属 UI 增强）。
