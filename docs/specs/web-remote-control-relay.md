# Spec：移动端远程控制 —— 外部中继（external relay）设备端

状态：spike 已通过，待实现完整设备端传输层。
关联：`packages/desktop/src/main/webRemoteControl/`、`packages/desktop/src/main/desktopRemoteSessions.ts`、`packages/shared/src/zcodeEndpoint.ts`、`packages/ui/src/WebRemoteControlDialog.tsx`

## 1 背景与目标

开源仓库的桌面端缺少「手机浏览器远控本机正在跑的会话」能力：UI 入口 `WebRemoteControlDialog.tsx` 只剩 Bot Channel 四张卡，外部中继的设备端整条链路未在源码中。发行版具备该能力。

目标：在本仓库自研一个**等价设备端**，使桌面主动外连厂商 relay 并完成配对，把手机终端桥到该窗口已有的 Local Host attachment 上，复用现有会话运行时。

非目标：不自建/替代 relay 服务端；不改协议投影与 delivery profile 语义；不为手机另起 Agent、Local Host 或远程会话。

## 2 已实测结论（2026-09-27，一次性连通性探针，脚本未入库）

| 判据                                                                      | 结果                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| relay WS 可达（`wss://<origin host>/ws?mid=<deviceMid>`）                 | 是                                                                                       |
| `device_register_init` 被接受并回 `device_register_ack{device_sid}`       | 是                                                                                       |
| `auth_init → auth_challenge → auth_response → auth_ack` 全流程            | 是                                                                                       |
| `pair_status_query` 心跳被持续回 `pair_status_ack{pair_status:"waiting"}` | 是                                                                                       |
| 出现 `KICKED` / `AUTH_FAILED` / `WRONG_PARAM`                             | 否                                                                                       |
| 打开终端配对链接后 `pair_status` 转 `matched`                             | 是                                                                                       |
| 设备端收到中继转发的终端流量                                              | 是：`data{zcode_type:"mobile-diagnostic"}` ×8、`data{zcode_type:"bootstrap-request"}` ×4 |
| 不回应 `bootstrap-request` 的后果                                         | 终端放弃、`pair_status` 回 `waiting`，随后重发 `bootstrap-request`                       |

结论：中继侧对非官方构建的设备端注册与握手**无额外校验**，且纯客户端实现即可收到终端流量，自研设备端可行。控制面有严格顺序：必须先答 `bootstrap-response` 才会进入 `workspace-list-request` 阶段。

未验证：终端页是否要求登录态 —— 实测用的是已登录浏览器，因此不能据此断言终端侧免鉴权。P3 实现时需要用未登录环境复测。

附带安全观察：注册阶段不校验账号身份，`pass_hash` 由设备自行生成并声明，因此整套配对的唯一秘密是 `pass_hash`（它经二维码进入手机侧 URL）。二维码泄漏等价于配对凭据泄漏 —— 设备端实现必须提供显式 reset 路径，且配对链接不得写入日志。

## 3 状态所有者

| 事实                        | 唯一所有者                         | 说明                                                                                     |
| --------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `device_sid` 与 `pass_hash` | Desktop Main（配对域）             | `device_sid` 由中继下发；`pass_hash` 存 credential store，`device_sid` 存 `setting.json` |
| 配对槽位与在线状态          | relay 服务端                       | 每 `device_sid` 单一 terminal 槽位，`KICKED` 即被顶替                                    |
| 会话/任务运行态             | CLI runtime                        | 经 Host attachment 暴露，Main 与 relay 均不持有                                          |
| v4 投影与重放               | CLI `conversation-topic-publisher` | `replayable` profile，Main 只透传                                                        |
| 终端页面                    | 厂商 relay 主机 `/remote/v4`       | 本仓库不镜像、不代管                                                                     |

## 4 协议

外层帧（JSON 文本，单帧上限 1 MiB）：

| 方向 | 帧                             | 字段                                                                               |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------- |
| 出   | `device_register_init`         | `device_mid` `pass_hash` `meta` `client_ts`                                        |
| 入   | `device_register_ack`          | `device_sid`                                                                       |
| 出   | `auth_init`                    | `role:"device"` `device_sid` `meta` `client_ts`                                    |
| 入   | `auth_challenge`               | `nonce`                                                                            |
| 出   | `auth_response`                | `device_sid` `proof` `client_ts`                                                   |
| 入   | `auth_ack` / `pair_status_ack` | `pair_status ∈ waiting\|matched`                                                   |
| 出   | `pair_status_query`            | `device_sid` `client_ts`                                                           |
| 双向 | `data`                         | `payload`（v4 wire 原样透传，`zcode_type ∈ rpc-frame\|rpc-frame-ack` 走 raw 通道） |
| 入   | `error`                        | `code ∈ KICKED\|AUTH_FAILED\|WRONG_PARAM\|INTERNAL` `message`                      |

凭据派生：`password = base64url(randomBytes(24))`（仅内存）；`pass_hash = base64(sha256(password))`；`proof = base64url(HMAC-SHA256(key=pass_hash, "<nonce>|<role>|<device_sid>"))`。role 参与签名，故 device 侧 proof 不能被 terminal 侧重放。

连接参数：查询串 `mid=<deviceMid>`，请求头 `X-Device-ID: <deviceMid>`，`perMessageDeflate: true`。`deviceMid` 读 `~/.zcode/v2/telemetry-state.json`。

## 5 事件顺序

```
Main 启动远控开关
  → WS connect(mid)
  → device_register_init ──▶ relay
  ◀── device_register_ack{device_sid}     持久化 device_sid + pass_hash
  → auth_init{role:device} ──▶
  ◀── auth_challenge{nonce}
  → auth_response{proof} ──▶
  ◀── auth_ack / pair_status: waiting      生成二维码 URL
手机扫码 ──▶ relay /remote/v4 ──▶ 终端与设备配对
  ◀── pair_status: matched
  ◀── data{bootstrap-request}              Main 应答 bootstrap-response
  ◀── data{workspace-list-request}         Main 应答 workspace-list-response
  ◀── data{workspace-bridge-open{bridgeSessionId, generation, recoveryId, taskId}}
       → attachRemoteWorkspaceSessionHost(clientMode:"web-remote-replayable")
         → Host: HostMessageTypes.AttachServicePort（复用既有 attachment 注册表）
       ◀─ service MessagePort
  ⇄ data{rpc-frame / rpc-frame-ack}        v4 wire 透传，Main 不解释业务
```

断连：固定 1 s + ≤2 s 抖动重连（无指数退避）；心跳 10 s ±20%；ack 超时 30 s 触发重连；`KICKED` 关闭 socket 借重连恢复。

## 6 验收场景

1. 开关打开后 30 s 内进入 `waiting_terminal`，二维码可被手机扫开且 `pair_status` 转 `matched`。
2. matched 后手机侧可见该窗口正在跑的会话时间线，且增量到达（`replayable`：只 text 流 + `row.upserted` 收口）。
3. 手机端发送输入被 CLI `CommandInbox` 串行受理；running 状态下按 `queue`/`guide` 语义分流，不重复执行。
4. 手机端 `approve`/`deny` 权限应答能落到桌面同一会话。
5. 拔网线 20 s 后恢复：设备端自动重连并重新 `auth_init`，终端侧经 `snapshot`/`resync` 恢复投影，无重复消息。
6. 桌面同时存在多个窗口时，只有开启远控的窗口产生 attachment；关闭开关后 relay 侧无残留连接。
7. 二维码 reset 后旧 `pass_hash` 立即失效。
8. 单槽互踢：第二台手机扫码后第一台收到终端失效，设备端不崩且回到 `waiting_terminal`。

## 7 阶段计划

- P0 spike：已完成（一次性连通性探针，脚本未入库）；结论落进 `relayProtocol.ts` 的凭据与帧常量。
- P1 设备端传输层：`relayDeviceTransport.ts`（状态机 + 心跳 + 重连）、`relayManager.ts`（开关与生命周期）、Main 装配点。
- P2 端点与设置：`zcodeEndpoint.ts` 补 `relayWsUrl` / `remoteUrl` / `webRemoteCallbackUrl`；`validationAppSettings.ts` 补 `webRemoteControlExternalRelayDevice` 与 `webRemoteControlLastEnabledContext`（两处 schema 都要加，否则 `z.object` 会剥掉未知键）。
- P3 桥接：`data` 帧 ⇄ `attachRemoteWorkspaceSessionHost`，含 `bootstrap` / `workspace-list` / `workspace-bridge-open` 控制面。
- P4 UI：配对卡 + 二维码 + reset；桌面/手机双端交互与 i18n。
- P5 E2E：覆盖 §6 全部场景。

## 8 控制面契约（从发行版 `routePayload` 还原，已核对字段名）

外层帧：入站 `{type:"data", server_ts, payload}`（relay 只加 `server_ts`），出站 `{type:"data", payload, client_ts}`。发行版 `sendAppPayload` 经 `payloadSerializer.prepare()` 产出同一形状，**不分片**；分片/确认层只作用于 bridge 内的 `rpc-frame`。设备端仅当 `state === "paired"` 且 `staleWaitingCount === 0` 时才允许发出 payload，否则 `unavailable` 并进入 `pendingOutboundPayloads`（上限 50，溢出整批丢弃并记 `dropped buffered outbound payloads`）。

`routePayload(payload)` 的完整分支：

| `zcode_type`                  | 设备端动作                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `bootstrap-request`           | 回 `bootstrap-response{requestId, success, result}`                                                           |
| `workspace-list-request`      | 回 `workspace-list-response{requestId, success, result}`                                                      |
| `workspace-list-updated`      | 主动推送（签名去重：`buildWorkspaceListPushSignature`）                                                       |
| `platform-request`            | 回 `platform-response{requestId, method, success, result\|error}`，method 走 `platformHandlers[method](args)` |
| `mobile-view-state-update`    | 记录 `viewState`/`deviceInfo`                                                                                 |
| `workspace-bridge-open`       | 建桥后回 `workspace-bridge-ready{requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, bridge}`         |
| `workspace-reconnect-request` | 重连既有桥                                                                                                    |
| `rpc-frame` / `rpc-frame-ack` | 走 raw 通道进 bridge                                                                                          |
| `telemetry-report`            | 转发渲染层埋点                                                                                                |
| `mobile-diagnostic`           | 仅日志                                                                                                        |

### 8.1 终端侧权威 schema（从 `https://<relay>/remote/v4/latest/assets/src-*.js` 的 zod 定义读出，非推断）

字符串 `Z = string().trim().min(1)`；id `Q = Z.max(256).regex(/^[A-Za-z0-9._~-]+$/)`。

```
workspace = { workspacePath: Z!, label: Z!, kind: "local"|"remote"!,
              workspaceIdentity?: Z, remoteSessionId?: Z,
              workspacePurpose?: "project"|"conversation",
              connectionState?: "connected"|"disconnected"|"reconnecting",
              lastConnectionError?: string }

task      = { taskId: Z!, title: string!, workspacePath: Z!, workspaceLabel: Z!,
              workspaceKind: "local"|"remote"!, createdAt: finite!, updatedAt: finite!,
              workspaceIdentity?: Z, remoteSessionId?: Z, provider?: Z,
              unreadAt?: finite, displayStatus?: "idle"|"running"|"completed"|"error",
              pinned?: bool, archived?: bool }

bootstrap-response result = { windowControlSessionId: Z!, workspaces: workspace[]!, tasks: task[]!,
                              initialViewState?: viewState, mobileViewState?: viewState }
workspace-list-response result = { workspaces: workspace[]!, tasks?: task[],
                                   activeWorkspaceKey?: Z, activeTaskId?: Z }
viewState = { activeWorkspaceKey?: Z, activeTaskId?: Z, updatedAt: finite! }
deviceInfo = { platform, version, name, userAgent?, language?, languages?, browserPlatform?,
               viewport?, screen?, timezone?, online?, updatedAt: finite }
```

**`workspaceKey` 不随线传输**：终端按 `workspaceIdentity?.trim() || workspacePath` 自行推导（发行版 `Ue()`/终端 `Ia()` 同一规则），但 `workspace-bridge-open` 的 payload 里会带回来。`desktopAppVersion`、`hasBackgroundWork`、`workflowActivity` 都**不在**线上 schema 内 —— 它们是桌面内部字段，发出去会被终端判为不合形。

`bootstrap-request` 的应答必须**逐字段合形**：终端对不合形的 payload 静默丢弃、不报错，只在超时后回 `mobile-diagnostic{event:"failure", failureReason:"desktop-bootstrap-timeout"}`。这是本次实测踩到的坑（缺 `label`/`workspaceLabel`/`workspaceKind` 且多给 `desktopAppVersion`）。

bridge 描述符是终端 zod 的 `kind` 判别式联合（在发行版终端页面的入口 bundle 里定义，
其对象构造器非 strict、`kind` 走判别式联合），两个变体的字段清单：

| 字段                | local      | remote       |
| ------------------- | ---------- | ------------ |
| `bridgeSessionId`   | `Q` 必填   | `Q` 必填     |
| `bridgeGeneration`  | `int` 可选 | `int` 可选   |
| `recoveryId`        | `Q` 可选   | `Q` 可选     |
| `kind`              | `"local"`  | `"remote"`   |
| `workspaceKey`      | `Z` 必填   | `Z` 必填     |
| `workspacePath`     | `Z` 必填   | `Z` 必填     |
| `workspaceIdentity` | 不出现     | `Z` **必填** |
| `remoteSessionId`   | 不出现     | `Z` **必填** |
| `initialTaskId`     | `Z` 可选   | `Z` 可选     |

远端 workspace 必须同时具备 `workspaceIdentity` 与 `remoteSessionId` 才可建桥
（`canBridge = kind!=="remote" || !!(workspaceIdentity?.trim() && remoteSessionId?.trim())`，
发行版 `pl`）。`workspace-bridge-open` 的 payload 只带 `workspaceKey` 与 `taskId`，所以这两个字段
由桌面侧的 workspace 列表反查得到，不回显终端原值；`workspaceKey` 是身份键，远程身份下等于
`workspaceIdentity` 而不是路径。远程目标缺任一个字段时**建桥失败**，不降级成 local 描述符——
那会让手机把远程会话当本地作用域代理。可选字段缺值一律"省略键"而不是补空串（`Z = trim().min(1)`）。

建桥失败的 reason 由错误码映射（发行版 `FW`）：
`DESKTOP_HOST_MISSING→desktop-disconnected`、`REMOTE_SESSION_MISSING`/`REMOTE_SESSION_WINDOW_MISMATCH→workspace-closed`、
`REMOTE_WORKSPACE_IDENTITY_MISSING`/`REMOTE_WORKSPACE_IDENTITY_MISMATCH→unsupported-action`、其余→`unexpected-error`。
reason 必须是终端 `sg` 枚举内的值。`platform-request` 的 method 白名单：`isDockerAvailable`、`listWSLDistros`、`listDockerContainers`、`listSSHConfigAliases`、`loadMcpFromUserDirectory`、`saveMcpToUserDirectory`、`migrateLegacyCommonMcp`。

终端侧 `mobile-diagnostic` 字段：`event`、`state`、`previousState`、`pairStatus`、`closeCode`、`closeReason`、`wasClean`、`wasPaired`、`failureReason`、`failureMessage`、`visibilityState`、`online`、`hiddenDurationMs`、`timestamp`。

## 9 阻塞点已定位并复验通过（2026-09-27）

曾出现「回了 `bootstrap-response` 但终端仍 `desktop-bootstrap-timeout`」。两个嫌疑原因的裁定：

- 官方实例占用同一 `deviceMid`（都读 `~/.zcode/v2/telemetry-state.json`）：完全退出 ZCode 后仍失败，**不是主因**；但实现时仍需考虑同机共存，见 §10。
- **payload 不合形：确认是根因。** 终端对不合形的 `result` 静默丢弃且不改错误码。按 §8.1 补齐 `label`/`workspaceLabel`/`workspaceKind` 并去掉 `desktopAppVersion` 后，同一条链路立刻走通：

  > **2026-09-28 更正归因**：真正起作用的是**补齐那三个必填字段**。事后按 schema 复核，终端的
  > 对象 schema 并未 `.strict()`，多余字段会被剥离而不是触发整帧拒绝——所以"去掉
  > `desktopAppVersion`"那一步是无关变量，当时被误记成修复的一部分。
  > 结论修正为：**只有"必填字段缺失或为空串"才会让整帧被丢**（`Z = string().trim().min(1)`）。
  > 这条更正的连带影响见 §11.4 ①。

```
matched → bootstrap-request{requestId}
        → （设备端回 bootstrap-response）
        → workspace-bridge-open{requestId, bridgeSessionId:"bridge-57cc…",
                                bridgeGeneration:1, workspaceKey:"<桩里给的 workspacePath>"}
```

终端主动选中桩里给的 workspace 并请求建桥，说明控制面契约已被完整验证。剩余工作只有 `workspace-bridge-ready` 与 `rpc-frame` 双向桥接。

已确认的外层帧：入站 `{type:"data", server_ts, payload}`（relay 只加 `server_ts`，无路由字段），出站 `{type:"data", payload, client_ts}`。

## 10 移植进度与剩余缺口（2026-09-27）

### 已完成（均通过 `pnpm typecheck` / `pnpm lint` / `architecture:check --changed`）

| 模块                                             | 作用                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/shared/src/zcodeEndpoint.ts`           | 补 `relayWsUrl` / `remoteUrl` / `webRemoteCallbackUrl`；`buildZCodeEndpointUrls` 增可选 `remoteApiVersion`（发行版按 appVersion 选 v3/v4 的判定未交付，暂固定 v4）      |
| `packages/shared/src/validationAppSettings.ts`   | 读取与 patch 两处 schema 各补 `webRemoteControlExternalRelayDevice{deviceSid}` 与 `webRemoteControlLastEnabledContext{workspacePath,workspaceIdentity?,initialTaskId?}` |
| `packages/shared/src/zcode-protocol-v4/index.ts` | 导出 `wire-binary`，使 `crc32WireBytes` / `encode                                                                                                                       | decodeWireBytesBase64` 可被 main 复用，避免另写一份 |
| `webRemoteControl/relayProtocol.ts`              | 控制面帧类型、凭据原语（password/passHash/proof）、心跳与重连阈值、日志脱敏                                                                                             |
| `webRemoteControl/relayFrameCodec.ts`            | relay 传输层 rpc-frame 分片/重组/ack，含终端 zod 的全部不变量与故障码                                                                                                   |
| `webRemoteControl/relayRpcBridge.ts`             | `IMessagePassingProtocol` 适配器：`send()` 切帧、入站组帧后 fire `onMessage`，待发队列上限 50 整批丢弃、分片超时与 gap 上报                                             |

### 关键缺口：main 拿不到「窗口本地 Host」的服务面

`desktopRemoteSessions.ts:881 attachRemoteWorkspaceSessionHost` 只查 `routesBySessionId`（SSH/WSL/Docker 会话），**对本地 workspace 无等价能力**。本地 Host 的服务端口在 `desktopHostProcess.ts:717-729` 创建后直接 transfer 给 renderer，main 不留句柄；该文件已预留 `onPortReady?: (port: MessagePortMain) => void`（`:97`）与 `attachInitialServicePort`（`:99`）两个钩子，但**全仓零调用者**。

同时 main 也无法回答「窗口 N 正在跑哪些任务」：只有 `windowWorkspaceMap: Map<winId, Set<path>>`（`main/index.ts:617`，renderer 上报且无 `workspaceIdentity`）与 `hostRunningTaskCountMap` 计数；`TaskRealtimeBus` 无任何查询接口，`handleWorkspaceRunningTaskCountChanged`（`desktopRemoteSessions.ts:1029`）已是空实现。

因此 bootstrap 的 `workspaces[]` / `tasks[]` 必须来自 Host，而不是 main。落地方案二选一，需先定：

- **A. 复用 Host attachment**：给本地 scope 增加一条 `AttachServicePort(scope:{kind:"local"})` 入口（Host 侧 `windowHostAttachmentRegistry.attach` 已支持 local scope），main 得到 `MessagePortMain` 后 `createMessagePortServiceConnection(port)` → 用 `IServiceAccessor` 手工组装 `ServiceCollection`（先例：`server/src/http.ts:437-441`）→ 在 `relayRpcBridge` 的 protocol 上 `new ChannelServer(...)` 暴露。改动集中在 main + Host 各一处，不新增状态所有者。
- **B. 由 renderer 代理**：renderer 已有 base services，把远控 bridge 放 renderer。代价是违背「Main 只做转发、renderer 不持有服务端事实」的现有分工，且窗口关闭即断链。

推荐 A：它和发行版的行为面一致（`createWorkspaceBridge` 走 Host attachment），且不产生第二份状态。

### 生产模块真实链路自检结果（一次性自检脚本，未入库）

用生产模块（`relayDeviceTransport` + `relayFrameCodec` + `relayRpcBridge` + `ChannelServer`）直连真实 relay 的结果：

```
state: connecting → registering → authenticating → waiting_terminal → paired
控制面: bootstrap-request 应答被接受 → workspace-bridge-open → bridge-ready → open() 放行 Initialize
数据面: 入站 rpc-frame 22 条、发出 rpc-frame-ack 15 条、degraded 0 次（无 gap / 无 crc32 失败 / 无溢出）
终端实际请求的频道: provider-settings(6) setting(4) onboarding-record(3)
                    model-selection(2) oauth(1) coding-plan-subscription(1)
```

`Unknown channel` 来自自检脚本只注册了 6 个频道，不是协议问题：`ChannelServer` 能正确反序列化终端请求并按名查找，说明分片、重组、ack、RPC 编解码全部工作正常。`relayWorkspaceBridge.ts` 默认注册 `ServiceChannels` 全量，正是为消除这一类缺口。

自检同时暴露了功能面事实：移动终端启动期会调用 `oauth`、`provider-settings`、`coding-plan-subscription`、`onboarding-record`、`model-selection`、`setting` —— 做功能对齐时这些频道必须在 Host attachment 后可用，不能只接 `zcodeAgent`。

### 第二轮自检（生产控制面 + 生产频道清单）

自检脚本改为调用 `buildRelayBootstrapResult` / `buildRelayWorkspaceListResult` 与 `listDefaultRelayBridgeChannels()`（`ServiceChannels` 全量）后：

```
bootstrap-response built by production control plane {"workspaces":1,"tasks":0}   ← 终端接受
bridge opened + Initialize sent
Unknown channel 次数: 0                                                            ← 频道清单完整
入站 rpc-frame 22 · 发出 ack 15 · degraded 0
```

结论：控制面载荷与频道命名均已与终端对齐；剩余功能差距只在「频道背后接的是不是真实 Host 服务」，不在协议。

### 已确认的 Host 侧能力（无需改 Host）

`host/index.ts` 的 `windowHostAttachmentRegistry.resolveScope` 对 `scope.kind === "local"` 直接返回该窗口的 `activeServices`（`generation: 1`），且 `AttachServicePort` 处理里已包含「数据库未就绪时把 attachment 排队」的逻辑。因此 main 只需按 `{type: AttachServicePort, requestId, attachmentId, clientMode: "web-remote-replayable", scope: {kind:"local"}}` 发消息并 transfer 一条**新建**的 `MessageChannelMain`——不能复用 `desktopHostProcess` 给 renderer 的那条端口，否则窗口会失去服务面。该入口已实现为 `relayHostAttachment.ts`。

### 实现注意

`IServerChannel.listen()` 的返回值会被 `ChannelServer` 当 `IDisposable` 保存并调用 `.dispose()`；返回裸函数会在 dispose 时抛 `Cannot read properties of undefined (reading 'dispose')`。

### 已装配进 main（本轮）

`packages/desktop/src/main/index.ts` 在 `deviceMid` 之后创建 `webRemoteControlManager` 并注册 IPC；退出清理挂在 `remoteSessionManager.disposeAllAndWaitForAppShutdown` 同一批次。

- 凭据：`createCredentialService()`（main 已有同款用法 `appTelemetryCredentialService`），key `web-remote-control:external-relay:pass_hash`。
- 配对身份：`mainSettingService.get/update` 读写 `webRemoteControlExternalRelayDevice.deviceSid`；是否走持久化鉴权由 passHash 与 deviceSid 同时成立决定，故清 deviceSid 只尽力而为、不作安全边界。
- 端点：`buildZCodeEndpointUrls(await resolveCurrentZCodeEndpointOrigin())`，每个会话解析一次。
- workspace 列表：`windowWorkspaceMap`（renderer 上报）；task 列表：控制面 attachment 的 `IZCodeTaskService.listTasks`。
- IPC 只信 Electron `sender.id` 反查窗口，禁止 renderer 传 windowId 控制他人窗口。
- 双 attachment 设计：控制面与每个终端桥各用一条独立 `MessageChannelMain`，避免同一 Host 端口上两个 ChannelClient 交错。

验证：`pnpm typecheck` 0 error；`tsc -p tsconfig.main.json` 错误数 87 = 基线（新增零）；`pnpm lint` 我的文件 0 条；`pnpm --filter @zcode/desktop build:no-runtime-assets` 成功，且 `out/main/index.js` 内已含 `device_register_init`、`external relay device connecting`、`workspace-bridge-ready`、`web-remote-control:enable`、`web-remote-control:external-relay:pass_hash` —— 证明装配进了产物而非死代码。

### 开发版实机验证（2026-09-27，`ZCODE_DATA_BASE_DIR=~/.zcode-dev-home`）

在真实运行的开发版里经 CDP 调用 `window.zcode.enableWebRemoteControl()`，全链路响应；配对链接打开后端侧状态推进到读取工作区列表。修掉的两个真实缺陷：

1. `TypeError: this.port.addEventListener is not a function` —— Electron `MessagePortMain` 是 Node EventEmitter 风格，不能直接进 `MessagePortProtocol`。适配器原先只在 `host/electronPort.ts` 里，而 `tsconfig.main.json` 的 `include` 仅 `src/main`、无法 import。已把 `wrapNodeStyleMessagePort` 下沉到 `@zcode/rpc`（`MessagePortLike` 的定义层），host 改为委托，main 复用，避免两份实现；同时把 `@zcode/client` 的 `createMessagePortServiceConnection` / `connectViaMessagePort` 签名由 DOM `MessagePort` 放宽为 `MessagePortLike`。
2. 持久化鉴权模式下拿不到二维码 —— `pairingUrl` 原先只在 `device_register_ack` 回调里生成，重连走 `auth_init` 时永远不产生。已改为 deviceSid 一旦可得即构造；复测确认同一 deviceSid（凭据复用）也能出链接。

当前端侧停在「当前工作区已关闭 / No opened desktop workspace is available for Web remote control.」，该文案是终端解析 `bootstrap-response` **成功之后**才会走的分支，即配对、鉴权、bootstrap 应答均已被接受；`workspaceCount` 为 0 是这次开发实例没有打开任何工作区（预置 `recentProjects` 未生效），属测试环境条件，不是链路缺陷。下一步需在一个已打开工作区的实例上复验 `workspace-bridge-open` 与 RPC 代理。

### 实机验证的外部阻断（2026-09-27 13:41）

在真实开发实例里连续验证时，厂商 relay 开始**拒绝本机的新设备注册**：同一份代码在 13:08 前后完成过 `register → auth → pair_status:matched → bootstrap 应答被终端接受`，而 13:41 独立探针在 `device_register_init` 后直接收到 `{type:"error", code:"AUTH_FAILED"}`，开发实例则在 `auth_init` 后被静默断链（close 1006，无任何帧）。随机新 mid 同样 1006，且不发首帧的空连接本来就会被立刻关闭，因此这不是客户端代码回归，而是服务端侧的限流/防护已触发。

据此不再继续重试注册（避免对他人服务造成压力）。剩余两段实机验证（`workspace-bridge-open` 与 RPC 代理）需要在服务端恢复接受注册后补做，或改用自建同协议的中继验证。

本轮同时补上一处健壮性修复：持久化 `device_sid` 在服务端已失效时，relay 不回 error 帧而是直接断链，原实现会拿同一个死 sid 无限重连；现在若一次连接从未拿到过 `device_register_ack`/`auth_ack`/`pair_status_ack` 且使用的是持久化凭据，则清除凭据并以 register 重来一次（仅一次，防死循环）。

### 验证用环境变量 `ZCODE_WEB_REMOTE_RELAY_ORIGIN`

- 用途：仅用于本地回环验证。指向一个自建的同协议中继（`scripts/dev/web-remote-local-relay.mjs`），使 `workspace-bridge-open` 与 RPC 代理这两段能在不触碰厂商服务的前提下被验证。
- 优先级：高于 `setting.json` 的 `zcodeEndpointOrigin`，仅影响 `relayWsUrl` / `remoteUrl` 两个派生端点，不影响 OAuth、模型网关、计费、分享等其它端点。
- 生效条件：`!app.isPackaged`。打包后的正式构建一律忽略该变量，避免变成可被外部注入的后端切换开关。
- 错误行为：值无法被 `normalizeZCodeEndpointOrigin` 解析时按未设置处理并记 warn，不静默回退到任意其它 origin。
- 测试覆盖：回环 E2E（设备端注册→鉴权→配对→bootstrap→bridge-open→RPC EventListen 双向）；后续若补 CI，需包含「打包态忽略该变量」的用例。

### 回环 E2E 实测结果（2026-09-27 14:01）

用本地中继 + 回环终端客户端驱动真实运行的开发版，结果：

| 环节                                     | 结果                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| 设备端注册 / 鉴权                        | `auth_ack: true`，`pair_status: matched`                                               |
| `bootstrap-response` 数据                | 真实数据：**6 个 workspace、67 个 task**（来自 Host 的 `IZCodeTaskService.listTasks`） |
| `workspace-bridge-open` → `bridge-ready` | 成功；app 侧日志 `workspace bridge active`                                             |
| 设备端 → 终端 RPC                        | 收到 `Initialize`（6 字节 `040106c80100`，crc32 校验通过）                             |
| 终端 → 设备端 RPC                        | 首轮判据有误，见下方「判据修正」                                                       |

### 回环 E2E 全绿（2026-09-28 00:02）

修掉凭据自愈死循环、并换用正确的通断判据后，同一条链路跑通全部环节：

| 环节                                     | 结果                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 设备端注册 / 鉴权 / 配对                 | `auth_ack: true`，`pair_status: matched`                                                                                       |
| `bootstrap-response`                     | 6 个 workspace、68 个 task（Host 的 `IZCodeTaskService.listTasks`）                                                            |
| `workspace-bridge-open` → `bridge-ready` | 成功                                                                                                                           |
| 设备端 → 终端                            | `Initialize` 6B，crc32 OK                                                                                                      |
| **终端 → 设备端 → 终端**                 | `PromiseSuccess id=7`，**返回 41 个真实 task**：终端发 `zcode-task.listTasks` → relay → 桌面 → 窗口 Local Host 执行 → 原路回帧 |
| `platform-request`                       | `platform-response{success:true}`，`listSSHConfigAliases` 返回真实 alias 列表                                                  |
| `workspace-reconnect-request`            | `workspace-reconnect-response{success:true, workspaceKey}`                                                                     |

设备端入站帧计数（临时 TRACE 日志取证，已移除）：`rpc-frame` 4、`rpc-frame-ack` 4、
`bootstrap-request` 2、`workspace-bridge-open` 2、`platform-request` 2、`workspace-reconnect-request` 2
（两轮终端会话各一次）。

#### 两条必须记住的协议细节

1. **`EventListen` 不当场回帧。** `ChannelServer.onEventListen` 只登记订阅，事件真正触发时才回
   `EventFire(204)`。判断「终端 → 设备」是否通，必须用 `Promise(100)` 请求看
   `PromiseSuccess(201)` / `PromiseError(202/203)`。
2. **RPC 实参是数组。** `ProxyChannel` 服务端是 `target.apply(handler, args)`，因此报文 body
   必须是「实参数组」`[arg1, arg2, ...]`；直接传对象会让被调方法拿到 `undefined`
   （实测报 `Cannot read properties of undefined (reading 'workspacePath')`）。

验证过程中修掉的夹具口径问题（同时确认了实现侧口径）：proof 的 HMAC key 是 `pass_hash` **字符串本身**，不是 base64 解码字节 —— 三处（设备端 / 本地中继 / 回环终端）必须一致，厂商中继接受设备端算法这一点已由真实配对成功证明。

#### 判据修正：`EventListen` 按协议不当场回帧

首轮把「发出 `EventListen(broadcast.onMessage)` 后没有回应」判成链路不通，这个判据本身是错的。
`packages/rpc/src/channelServer.ts` 的 `onEventListen` 只做 `channel.listen(...)` 订阅并把 disposable 记进
`activeRequests`，**不发任何应答**；只有事件真正触发时才回 `EventFire(204)`。`broadcast.onMessage`
在空闲桌面上不会自发触发，因此「没有回应」是正确行为，不是故障。

正确的通断判据必须用 `Promise(100)` 请求：`ChannelServer.onPromise` 一定会回
`PromiseSuccess(201)` 或 `PromiseError(202/203)`。回环终端夹具已改为发
`zcode-task.listTasks{workspacePath,workspaceIdentity}`（只读、无副作用），并按
`deserializeRpcMessage` 解出 header 类型判定，而不是再靠 hex 前缀猜。

#### 重连抖动的根因（2026-09-27 23:27 实测）

现象：设备端每 ~2s 一次 `connecting` → `disconnected{code:1005}`，中继侧完全无日志，
状态停在 `error`。根因不在中继，而在 `relayManager.startSession`：

```
resolveAuth: () => persisted ? {mode:"persisted", deviceSid: storedDeviceSid, ...} : {mode:"register", ...}
```

`persisted` / `storedDeviceSid` 是**启动时快照的常量**。当 relay 不认识这个持久化 sid（换中继、
sid 过期）时，transport 会走「清凭据 + 重新注册」的自愈分支并回调 `onClearAuth`，但下一次
`connect()` 再调 `resolveAuth()` 拿到的仍是同一个死 sid —— 自愈被自己的依赖注入抵消，形成死循环。

修法：凭据改为**会话级可变状态**（`session.credentials` + `persistedDeviceSid`），
`onRegisteredAuth` / `onClearAuth` 同步更新，`resolveAuth` 每次读当前值；清凭据时同时换新
`password/passHash` 并作废 `pairingUrl`（旧二维码里的 hash 已失效）。
配套把 transport 的「持久化 sid 失效只回退一次」额度改成在**鉴权真正通过后**续期
（`auth_ack`/`pair_status_ack`），而不是 `device_register_ack`：否则「注册成功 → 鉴权失败 →
清凭据 → 再注册」会变成另一种无限循环。

### 第三轮字段级对齐（2026-09-28，逐条从发行版解包产物核对）

以下几处本仓库原先的实现与发行版不一致，均已按实测契约改正。证据来自发行版安装目录
（只读复制后解包）的 main 进程 bundle 及其 chunk，函数名在产物里以注解形式保留，可按名核对。

1. **注册帧 meta 的字段名**。发行版是 `{platform, version, name}`，本仓库此前写成
   `{platform, app_version, name}`。版本键名不同，对中继来说就是缺字段。
2. **`name` 的取值**。发行版 `deviceName: Kz()`，而 `Kz` 来自
   `import{homedir as OP, hostname as Kz} from "os"`，即机器名。本仓库此前固定写 `"ZCode"`。
   现改为 `hostname()`，同时作用于注册 meta 与配对 URL 的 `name` 参数。
   实测：配对 URL 的 `name` 变成 `…&name=<本机机器名>&…`，与发行版一致；此前恒为 `ZCode`。
3. **配对 URL 的参数集合与非空守卫**。发行版
   `buildWebRemoteControlExternalQrUrl` 只设 `sid/hash/t`，`mid/name/app_version` 三个是
   「值 trim 后非空才设」。本仓库此前无条件设置，会把空设备名以空串形式推给终端。
   注意 URL 里的版本参数名是 `app_version`（与注册 meta 的 `version` 不同名，不是笔误）。
4. **`bootstrap-response` 补 `desktopAppVersion`**，并改掉 `initialViewState` 的推导：
   发行版只有在会话带着 `initialTaskId` 启动、且主 workspace 可桥接时才给出该字段，
   否则缺省。本仓库此前拿任务列表第一条顶替，语义是「最近的任务」而非「桌面正在看的那个」，
   会让终端首屏跳到用户没在看的会话。
5. **`mobile-view-state-update` 是设备端要保存的状态**，不是可忽略的通知。
   发行版 `applyMobileViewStateUpdate` 把它写进会话，之后的 `bootstrap` 与
   `workspace-list-*` 都以此为准。本仓库此前按「静默接收」丢弃。
6. **`activeWorkspaceKey` / `activeTaskId` 的优先级**。发行版：
   终端上报的视图 → 桥的 `initialTaskId` → 桌面推断的初始视图 → 主 workspace。
   主 workspace 的定义是「有桥取桥所在，否则取窗口第一个」。
7. **`workspace-list-updated` 的内容签名去重**。见上文实测数据。
8. **task 排序补 tie-breaker**：`updatedAt` 倒序后按 `createdAt` 倒序、再按 `taskId` 字典序。
   顺序不稳定的列表会让签名无意义地抖动。

已知偏差（有意保留，不影响链路可用）：

- 推送签名里发行版还哈希 `hasBackgroundWork` / `workflowActivity` 两个字段，它们属于会话快照，
  不在 §8.1 的 wire `task` 结构里，本仓库既不发送也不纳入签名。

**`featureGate` 不是远端开关，此前判断有误（2026-09-28 更正）。** 发行版实现是

```
function Gb(e = !0) {
  return { isEnabled: () => e, assertEnabled: () => { if (!e) throw new Error("Web remote control is disabled in this build"); } };
}
```

装配点写的是 `featureGate: Gb()`，不传参即恒为 `true`，错误文案是 "disabled in this build" ——
一个**构建期常量**，不是服务端下发的功能位。因此本仓库不设门禁与该判断行为等价，无需复刻；
不能把它理解成"厂商可以远程关掉开源版"，反过来也不能理解成开源版少了自愈能力。

**凭据必须成对读取。** 发行版的 auth storage 在 `load` 时发现 `deviceSid` / `passHash` 只剩一半就
主动清掉并记 `external relay auth partial state cleared`。本仓库此前只是"缺一个就按新设备注册"，
不把残键清掉，于是每次启动都重复同一判断、脏键永久留存。现由 `loadPairedRelayCredential` 成对清空。

### 官方中继实机联验通过（2026-09-28 01:27–01:31）

去掉 `ZCODE_WEB_REMOTE_RELAY_ORIGIN` 覆盖后重启开发实例，让设备端直连厂商生产中继，并用厂商托管的
终端页面（`https://zcode.z.ai/remote/v4?…`）作为终端侧，全链路成立：

| 环节                       | 结果                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 沿用旧 sid 首次连接        | 生产中继以 `1006` 关闭 → 触发「持久化 sid 失效只回退一次」→ 清凭据后重新注册                               |
| `device_register` / `auth` | 成功，中继签发新的 `device_sid`，状态进入 `waiting_terminal`                                               |
| 打开官方托管终端页         | 设备端日志出现 `workspace bridge active`，即 `pair matched` + bootstrap + `workspace-bridge-open` 全部完成 |
| 终端首屏数据               | 页面显示「已连接到当前桌面窗口」与真实的工作区数 / 任务数（来自窗口 Host）                                 |
| 点开某个任务               | 进入任务会话视图，真实分支名、上下文用量、模型与推理档位选择器均由桌面 Host 供给                           |
| 关闭开关                   | `device stopped{reason:'renderer-request'}`，`webRemoteControlLastEnabledContext` 被清除                   |

要点：设备端不保存任何业务状态，工作区列表、任务、会话详情、用量与模型清单全部经 bridge 的 RPC
频道从窗口 Host 实时读取，因此官方终端页看到的是桌面的真实事实源，而不是本仓库另存的一份副本。

这也证明第三轮对齐后的注册帧字段（`meta.name` 为机器名、版本键为 `version`）被生产中继接受。

### 验收场景 7 / 8 实测与一处重连缺陷（2026-09-28 01:44–01:53）

**§6-8 单槽互踢（设备侧）**：给回环中继加 `--kick`，让第二台终端接入时对设备端下发
`{type:"error", code:"KICKED"}`。实测设备端行为：记录 `relay kicked current terminal slot` →
连接以 `1005` 关闭（`wasPaired:true`）→ 重连 → 状态回到 `waiting_terminal`，全程不崩、无僵尸桥。
第一台终端看到 `closed:1005`，第二台拿到 `pair_status=waiting`（因为设备端已被踢走）。

过程中量到一个真实缺陷：**踢线后设备端要等约 31 秒才重连**。根因是 close 回调里的
`if (state !== "paired") scheduleReconnect()` —— 中继发 KICKED 时状态仍是 `paired`，这条门禁把
该次关闭的重连整个跳过，只能靠心跳超时（30s）兜底。发行版的 close 处理没有任何状态门禁，只做
`!manuallyClosed && !terminalClose` 判断。改为无条件调用 `scheduleReconnect()`（其内部已有
`manuallyClosed` 守卫），同时补上 close 时停掉心跳与看门狗定时器（此前只有 `stop()` 会停）。
**修复后实测踢线到重连 1.2 秒**，与 `reconnectDelayMs` + 抖动一致。

**§6-7 二维码 reset 后旧凭据失效（设备侧）**：`resetPairing` 前后落盘的 `deviceSid` 由
`d_e9abb6…` 换成 `d_2c2ff3…`，旧值在 `setting.json` 与 `credentials.json` 中均不再存在，
passHash 同步重发。即设备端确实完成了轮转，旧配对链接指向的已不是本机凭据。

**这条场景无法在本地断言的部分**：回环中继的 `devices` 表只增不删，所以拿旧 sid 去连仍会被自己的
测试替身放行。厂商中继对 sid 的实际过期/回收策略属服务端行为，解包产物里看不到，不做推断。
要完整验证 §6-7 需要由官方中继侧确认旧 sid 被拒。

**出站/入站帧穷举比对（2026-09-28）。** 把解包产物里所有 `zcode_type:"…"` 字面量与实现逐条对撞：

- 出站帧发行版共 11 种，本仓库实现 10 种，唯一差集是 `app-error`。
  但 `app-error` 在发行版里是**不可达代码**：它唯一的发送点在 `mapTransportState` 的
  `if(b==="kicked")` 分支里（`preserveWindowRuntimeFailure`），而全 bundle 从未出现
  `setState("kicked")`。实际被设置过的状态只有
  `idle / connecting / registering / authenticating / waiting_terminal / paired / error` 七个，
  与本仓库 `ExternalRelayDeviceState` 完全一致。因此**不实现 `app-error`**，否则等于凭空加行为。
- 入站帧发行版 `routePayload` 共 10 个 case，本仓库此前显式处理 8 个，缺
  `mobile-diagnostic` 与 `telemetry-report`。
  现已补上 `mobile-diagnostic` 的落日志（字段与发行版同集合：event/state/previousState/
  pairStatus/closeCode/closeReason/wasClean/wasPaired/failureReason）——手机侧报"连不上"时
  设备端是唯一能看到这条自述的人。
  `telemetry-report` 仍只静默接收：发行版把它转进自己的遥测管线，本仓库不把远端传入的事件灌进
  用户的上报链路。

### 待办

1. UI：`WebRemoteControlDialog.tsx` 的「外部中继」卡片（二维码 / 状态 / 启用 / 关闭 / 重置）。
   **间接验证**：2026-09-28 00:25 的 app 日志出现 `stopped{reason:'renderer-request'}` →
   `connecting` → `stopped{reason:'renderer-request'}` 的关-开-关序列，只能由面板按钮触发，
   说明按钮与 IPC 双向都通；但二维码渲染本身尚未做点击级核对。
2. 实机验证：**配对 → 终端显示真实 workspace/task → 打开任务会话** 已在官方中继上通过
   （见上一节）。仍未实测的是「手机端发送输入」与「权限 approve/deny 回到桌面」两条，
   需要真机（手机浏览器扫码）才能算完整覆盖，桌面侧浏览器点击不足以代表手机端的输入路径。
3. ~~`platform-request` 方法白名单~~ **已实现并实测（8 个）**：`relayPlatformHandlers.ts` 复用桌面 IPC
   的同一批函数；回环实测 `listSSHConfigAliases` 与 `createTempTextAttachment` 均 `success:true`。
   **更正此前的错误判断**：先前记为「`createTempTextAttachment` 不在终端 method 白名单里、终端永远不会
   请求」，实测不成立——终端 composer 的粘贴长文本落盘路径就会调用
   `requestPlatformMethod('createTempTextAttachment', {text, filename})`，因此已补齐为第 8 个 handler。
4. E2E：§6 八条场景当前覆盖度——1 已在官方中继上通过；2 覆盖到"列表与任务会话视图来自真实 Host"，
   增量流未单独断言；5/7/8 的设备侧行为已实测（含本次修掉的重连延迟缺陷），终端侧投影恢复未验；
   6 只验了关闭开关后无残留连接，多窗口选择性建桥未测；
   **3、4（手机端发送输入、权限 approve/deny）必须用真机扫码才能算覆盖**，桌面浏览器点击不能代表
   手机输入路径。
5. ~~`workspace-list-updated`~~ **已实现并实测**：`notifyWorkspacesChanged(windowId)` 挂在 main 的
   `syncTaskRealtimeWorkspaceKeys`（窗口 workspace 集合变化的唯一入口）上，仅在 paired 时推送，
   带在途去重 + 内容签名去重（`buildRelayWorkspaceListPushSignature`）。
   2026-09-28 00:21–00:23 回环实测：6 次 tab 同步触发（3 次内容不变 + 1 次新增 workspace + 2 次不变）
   只收到 1 条推送，且推送内容与终端此前上报的 `activeWorkspaceKey` 一致。
6. ~~`webRemoteControlLastEnabledContext` 启动恢复~~ **已实现并实测**：
   - `enable` → `saveStartupRestoreContext` 落盘（已核对 `~/.zcode/v2/setting.json` 写入正确）；
   - `disable(reason!=='window-closed')` → `clear()`（已核对设置项被移除，重启后不再自动启用）；
   - 关窗（`reason==='window-closed'`）**不**清上下文，保留用户意图；
   - 重启后 app 日志出现 `启动恢复上次启用的远控会话` 并立即连中继。
   - 恢复不以「上次那个 workspace 此刻是否打开」为门禁：workspacePath 只是给终端的首屏提示，
     当门禁会被「窗口先报单个 tab、随后才补齐」的时序永久吃掉。
7. 关窗回收：`browser-window-created` 的 `closed` 回调里补了 `disable(win.id,'window-closed')`，
   否则窗口作用域的 relay 会话与 Host attachment 会一直挂着。

## 11 弹窗 UI 与发行版对齐（2026-09-28）

以发行版 renderer 产物为准逐元素还原（不是照截图目测猜样式），差异集中在结构而不是配色：

| 项         | 此前（开源版）                        | 发行版                                                                                   |
| ---------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 布局       | 单列纵向堆叠                          | `md:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]` 两栏，弹窗 `max-w-4xl`               |
| 卡片标题   | 「外部中继直连」                      | 「手机扫码连接」                                                                         |
| 弹窗副标题 | 「通过聊天机器人控制 ZCode 工作区。」 | 「扫码或在手机上打开链接，即可远程控制当前工作区。」                                     |
| 启动方式   | 需要手点「启用并生成配对码」          | **打开弹窗即自动启动**，卡内只有「停止」（idle 时禁用）                                  |
| 状态呈现   | 一个圆角标签                          | 状态词 + 圆点胶囊（`bg-destructive`/`bg-success`/`bg-border`/其余 `bg-warning`）+ 说明行 |
| 复制链接   | 无                                    | 「无法扫码？」行内含「刷新二维码」「复制链接」，且整行在连接卡内部                       |
| 刷新二维码 | 直接执行                              | 二次确认弹窗，按钮带 `esc` / `⏎` 键位提示                                                |
| 二维码容器 | 实线小框                              | 虚线 `border-dashed bg-background-alt`，未就绪时转圈 +「正在准备二维码...」              |

文案改成了与发行版同一套 i18n key（`webRemoteControl.status.*`、`statusDetail.*`、
`statusTag.*`、`mobileQr.*`、`copyLink*`、`refreshQr*`、`stop`、`startFailed`），
中英双语都取自其 renderer 语言包原文，不再自造措辞；原先的 `webRemoteControl.relay.*` 一套键已删除。

设备端状态到展示五档的映射：`disabled|idle→idle`、`connecting|registering|authenticating→starting`、
`waiting_terminal→running`、`pairing→connecting`、`paired→active`、`error→error`。

实测：两栏计算后为 496px / 342px，二维码与自动启动生效；刷新走确认弹窗后
`deviceSid` 由 `…DUkMm5` 轮转为 `…7hv8qL` 并回到 `waiting_terminal`。

### 顺带修掉的写入竞态

`enable` 写 `webRemoteControlLastEnabledContext`、`disable` 清它，两边都是不 await 的异步落盘。
先 enable 再 disable 时，clear 可能先落、save 后落，结果是**用户已经关掉远控，下次启动却自动又打开**。
现在两条写操作串到同一条 promise 链上，按调用顺序生效。实测连做
enable→disable→enable→disable 四次后，落盘意图与最后一次调用一致（不存在）。

### 已知偏差（UI）

- `webRemoteControl.failure.*` 十二条文案已随语言包补齐，但**未接渲染分支**：发行版那条分支读
  `status.failure`，而 `failure` 只由不可达的 `kicked` 路径产生（见 §10）。本仓库状态面没有
  `failure` 字段，因此不预先铺一条点不到的 UI。

## 11.1 停止语义、二维码稳定性与侧边栏状态（2026-09-28 第二轮）

从发行版 renderer 的 `stop` 处理函数（压缩名 `E`）逐行还原，此前实现有三处不对：

**一、停止必须关弹窗。** 发行版是

```
await platform.stopWebRemoteControl();
setLocalStatus({ status: "idle" });
onOpenChange(false);                 // 弹窗自己关掉
toast("webRemoteControl.stopSuccess");
```

本仓库此前只调 disable，弹窗留着，于是显示的是一个已经不存在的会话的二维码。

**二、停止不能被自动重启逻辑顶回去。** 本仓库的「打开弹窗即启动」effect 原先以
`!open || !supported || status.enabled` 为门禁 —— 点停止后 `status.enabled` 变 false，
而弹窗还开着，effect 立刻把刚停掉的会话又 enable 一遍，表现成**「点停止反而刷出了新二维码、
新地址」**。现在只认 `false→true` 这一次跳变（`wasOpenRef`），停止后不再自愈式重启。

**三、配对链接按 `passHash` 缓存。** 发行版每次 `start()` 用 `Date.now()` 重算 URL 里的 `t`，
但用户观察到「停止再进来二维码还是原来那张」，说明同一份凭据应当只对应一个链接。
本仓库改为在 manager 内以 `passHash` 为键缓存配对 URL：enable/disable 反复切换命中同一个链接，
`刷新配对`（轮转 passHash）自然换键、产出新链接。缓存不写盘，进程重启后重新生成。

**侧边栏入口的状态样式。** 发行版 `vin(status, formatMessage)` 决定图标配色与提示文案，
入口按钮在 compact 模式下只有图标，状态全靠颜色表达：

| 展示状态   | 图标配色                 | tooltip 文案 key           |
| ---------- | ------------------------ | -------------------------- |
| error      | `text-destructive`       | `triggerStatus.error`      |
| active     | `text-success`           | `triggerStatus.connected`  |
| starting   | `text-warning`           | `triggerStatus.starting`   |
| connecting | `text-warning`           | `triggerStatus.connecting` |
| running    | `text-warning`           | `triggerStatus.waiting`    |
| idle       | `text-foreground-subtle` | `triggerStatus.idle`       |

设备端 9 个状态到展示 6 档的映射、以及这张配色表，抽到
`packages/ui/src/webRemoteControlView.ts` 单一来源，入口与弹窗共用，
避免出现「图标说已连接、卡片说等待手机」的自相矛盾。文案 key 此前已随语言包补齐，
现在真正被消费。

实测（回环中继、全新实例）：开弹窗 → 点停止 → **弹窗关闭**、状态 `disabled`；
重新打开 → `pairingUrl` 与停止前**逐字符相同**；走「刷新二维码」二次确认后 → URL 变化；
侧边栏图标在等待手机时为 `text-warning`（截图可见琥珀色），停止后回到 `text-foreground-subtle`。

> 排查记录：这轮第一次跑验证时六项断言全不过，原因是新起的 `pnpm dev:desktop` 因
> 5174/9229 被上一实例占用而 `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` 退出，我测的是旧构建。
> 结论：改完 main 进程代码后，启动必须确认窗口是真的新建了（看 launchMarks / 日志行数），
> 不能只看 CDP 端口有没有应答。

## 11.2 状态胶囊显示连接设备类型（2026-09-28 第三轮）

**更正 §11 里的一条判断。** 上一轮我把 `mobileDeviceInfo` 记成「本仓库状态面没有对应字段、
也没有消费方，收到后不落盘」——这个判断是错的，消费方就是状态胶囊。

发行版胶囊文案的取值函数是

```
mobileDeviceInfo?.browserPlatform?.trim()
  || mobileDeviceInfo?.name?.trim()
  || (mobileConnected ? statusTag.phone
      : status==='idle' ? status.idle
      : status==='error' ? status.error
      : statusTag.ready)
```

`browserPlatform` 由终端取 `navigator.platform` 塞进 `mobile-view-state-update` 的 `deviceInfo`，
所以**用电脑浏览器打开配对链接时胶囊是 `Win32`**，只有终端没报平台名时才回落到「手机」。
本仓库此前固定回落到「手机」，用电脑连也显示手机。

已补齐的链路：终端 `deviceInfo` → `parseRelayDeviceInfo`（只挑 `browserPlatform`/`name`
两个非空白字段）→ 会话 `deviceInfo` → `WebRemoteControlStatus.deviceInfo` →
`webRemoteControlStatusTagText()` 按上面的优先级出文案。设备信息变化时 `publish()` 立即广播，
否则胶囊会停在上一台设备的名字上。

只存界面用到的两个字段：发行版的 deviceInfo 还带 userAgent / viewport / screen / timezone，
本仓库不展示就不收集远端浏览器塞进来的用户环境数据。

实测（回环中继、全新实例、终端上报 `browserPlatform: "Win32"`）：
`state=paired`、状态词「手机已连接」、胶囊「Win32」、圆点 `bg-success`；
终端断开后状态词回到「等待手机连接」、圆点转 `bg-warning`，胶囊仍留 Win32
（与发行版一致：没有任何一方在解除配对时清 `mobileDeviceInfo`）。

## 11.3 终端离开后胶囊要回落到「已就绪」（2026-09-28 第四轮）

上一轮补了设备信息上报，但漏了它的**生命周期**：终端关掉标签页之后，胶囊还挂着上一台的
`Win32`，而发行版回落到「已就绪」。

发行版 renderer 的取值函数本身没有"清除"分支（`browserPlatform || name || …`），
main 侧也只在 `applyMobileViewStateUpdate` 里赋值一次；能回落到「已就绪」只有一种解释——
**`deviceInfo` 描述的是当前占着配对槽位的那台终端，槽位空了它就不该再随状态发出去**。
因此按这个语义在设备端补了回收：会话从 `paired` 转到其它状态时清掉 `session.deviceInfo`，
`onClearAuth`（凭据作废、要重新注册）时一并清掉。

实测（回环中继、全新实例）：

| 时机           | state              | deviceInfo                    | 状态词       | 胶囊                       |
| -------------- | ------------------ | ----------------------------- | ------------ | -------------------------- |
| 终端连上       | `paired`           | `{browserPlatform:"Win32",…}` | 手机已连接   | Win32（圆点 `bg-success`） |
| 终端关掉标签页 | `waiting_terminal` | `null`                        | 等待手机连接 | **已就绪**                 |

### 顺带修掉一个上一轮自己引入的缺陷

「配对链接按 passHash 缓存」的键选错了。`passHash` 不变但 `deviceSid` 被中继换发时
（旧 sid 不被识别 → 重新注册），缓存会命中**带着旧 sid 的死链接**，二维码和实际设备脱节，
终端拿这个链接连回来就是 `AUTH_FAILED unknown device_sid`。两处一起改：

- 缓存键改成 `passHash|deviceSid`；
- `onStateChange` 里补建链接的判据从「`pairingUrl` 是否存在」改成
  「`pairingUrlSid` 是否等于当前 sid」，并新增 `session.pairingUrlSid` 记录归属。

> 验证过程中的两个假象，都记下来避免重犯：
> ① `pkill -f` 在 Git Bash 下没杀掉终端进程，设备端当然还是 `paired`，看起来像"清除没生效"；
> ② 回环中继的日志只打 sid 后 6 位，拿它和应用里完整 sid 的前 16 位对比会误判成不一致。
> 结论：断言行为前先确认测试夹具本身的状态真的变了。

## 11.4 五路独立复核与修正（2026-09-28）

对协议、传输状态机、控制面、UI、跨进程链路各派一个只读复核代理，逐条对着解包产物核。
下列结论**推翻或补充了本文档前面的记载**：

**① 终端 schema 不是 `.strict()`，多余字段是被剥离而不是整帧拒绝。**
本文 §8.1 附近与 `buildBridgeDescriptor` 的注释都写成"多发字段会被判不合形/静默丢弃"，
不准确。真正的风险只有一个方向：**必填字段缺失或为空串**。终端里
`Z = string().trim().min(1)`，而 `bootstrap-response.result.windowControlSessionId` 是 `Z` 必填，
所以 `getDeviceSid() ?? ""` 会让**整条 bootstrap-response 被判不合形丢弃**，终端只报
`desktop-bootstrap-timeout`。已改为取不到 sid 时省略该字段并由路由回 `success:false`。
同类空串风险（`workspaceKey` / `bridgeSessionId` 用 `String(x ?? "")`）与
`openBridge` 遇重复 bridgeSessionId 静默 return（终端只能等到超时）一并处理。

**② 启动恢复的门禁是我误删的，方向反了。**
发行版 `restorePreviouslyEnabled` 明确有"上次那个 workspace 此刻还开着"这道门禁
（`b.find(te => Ue(te) === Ue(saved))`，找不到就 return false），并且**不消耗一次性标志**，
所以窗口每次补齐 workspace 都会重试。我此前为了躲"先报一个 tab"的时序把门禁整个去掉，
后果是恢复会落到窗口第一个 tab 上——等于把远控开在用户没授权过的工作区。已恢复门禁 + 可重试。

**③ `initialTaskId` 从来没落过盘。** `saveStartupRestoreContext` 只写 workspacePath，
而读取侧用 `saved.initialTaskId`，于是 §10 第 4 条辛苦对齐的 `initialViewState` 整条链是死的。

**④ 终局错误被降级成可恢复。** 缺 `terminalClose`，`WRONG_PARAM`/未知错误码/`AUTH_FAILED`
额度用尽后都只 `setState("error")+close`，而 close 又触发重连 → 中继持续拒机时是每秒一次的
无限重连，UI 永远停在"连接中"。已补 `enterTerminalError` + 终局原因上抛，
并接通 `failure` 字段与 §11 提到的 12 条 `failure.*` 文案（此前那批 key 根本不存在，
文档说"已补齐"是错的）。`INTERNAL` 改为按发行版分流：会话仍活跃时保留链路回 waiting，
不活跃才重连。

**⑤ 出站缓冲三处问题**：无滞留上限（断线几分钟后的过期 RPC 回执会被原样推给终端）、
`sendPayload` 在 paired 时直发可插到积压帧前面（乱序）、字节数按裸 payload 量而实际发的是
套壳帧（队头可能永久发不出去）。已抽成 `relayPendingOutbound.ts`，按物理帧计量 + 5s 整批过期

- 有队列时排队尾。

**⑥ 入站缺字节闸门与降级上报。** 发行版入站先过 `maxPhysicalFrameBytes`，超限丢弃并回调
`onRawTransportFault("remote.rpcFrame.envelopeTooLarge")` 转成桥的 `bridge-degraded`，
终端据此 recoverConnection。本仓库此前完全没有这条链路，表现为"连上但偶发丢帧/卡流且不自愈"。
已补入站字节闸门、`maxPayload`、以及 fault→桥降级。

**⑦ 凭据写入两条独立异步链**（`onRegisteredAuth` 的 save 与 `onClearAuth` 的 clear）可互相覆盖，
新凭据可能被随后的 clear 抹掉。已与"上次启用上下文"一起并入同一条持久化队列。

**⑧ AUTH_FAILED 不该换口令。** 发行版拒收持久化 sid 时**沿用同一 passHash**、只丢 sid 重新注册，
所以用户已扫过/复制过的链接里的 `hash` 继续有效；本仓库此前重新生成整对凭据，
等于把那张二维码作废。已改为只丢 sid。`resetPairing`（怀疑泄漏）仍然轮换口令——这两条路径必须分开。

**⑨ 未知 `pair_status` 不该降级。** 发行版只认 `waiting`/`matched`，其余不改状态；
本仓库有兜底 `setState("waiting_terminal")`，一条畸形 ack 就会把工作中的 paired 会话打下来
（并连带清设备信息、停列表推送）。已去掉兜底。

**⑩ 视图状态不该做条件覆盖。** 只比 `activeTaskId` 会把"用户只切了工作区"的更新整条丢掉，
发行版是无条件覆盖。已改。

### 复核确认「一致」的部分

握手帧字段、password/passHash/proof 算法与编码、注册 meta 键名与 `os.hostname()`、
配对 URL 参数集合与非空守卫、WS 握手（`/ws` + `mid` + `X-Device-ID` + perMessageDeflate）、
rpc-frame 字段与上限（1 MiB 物理帧 / 16 MiB 消息 / 64 分片 / 30s 组装）、crc32 多项式与
`checksum.value` 正则、队列上限 50、心跳 10s / ack 30s / 重连 1s、恢复窗 15s、
状态集合（含 `kicked` 在发行版确为不可达死分支、不实现是对的）、
凭据成对校验、KICKED 处理、attachment 与 Initialize 放行时机、弹窗全部容器类名与
四张状态映射表、57 个共有 i18n key 的中英值零差异。

### 尚未处理（明确记账，不算已完成）

- 远程 workspace 建桥的**描述符与失败原因已对齐**（`buildBridgeDescriptor` 产出 local/remote 两种
  形态、`mapRelayBridgeFailureReason` 按错误码回 reason，用例见
  `packages/desktop/test/webRemoteControlBridge.test.ts`）。**仍不能端到端连远程 workspace**，
  缺的是前置条件而不是这段代码：本窗口远程 workspace 无法被列举。
  - `windowWorkspaceMap`（`main/index.ts`）按契约只收本地路径，`packages/ui/src/root/useRootPlatformEffects.ts`
    在 `syncWindowTabs` 之前显式滤掉 `remoteSessionId`/`workspaceIdentity`/`remoteTarget` 的 tab，
    所以远程 workspace 从来到不了 main。
  - main 侧唯一持有远程连接事实的地方是 `desktopRemoteSessions.ts` 的 `routesBySessionId`
    （`remoteSessionId` + `webContentsId` + `workspacePath`/`workspaceIdentity`/`target.kind`/
    `attachmentState`），字段够用，但它的对外接口只有按 id 的 `attachRemoteWorkspaceSessionHost`
    和计数用的 `getRemoteConnectionStats`，**没有"按窗口列举"的入口**。
  - 因此 `listRelayWorkspaces()` 目前恒产出 local 条目。补齐列举入口需要一次跨模块决策：
    由 `desktopRemoteSessions` 暴露 per-window 列表（含 `attachmentState` → 终端 `connectionState`
    的口径），还是让 renderer 把远程 tab 连同身份一起同步给 main（会改动 `syncWindowTabs` 契约）。
    两者都会新增一条 main 侧的 workspace 事实通路，必须先定所有者，不能先伪造一条数据。
  - 列举入口就位后要改的只剩三处，且都已单点化：`listRelayWorkspaces` 并入远程条目、
    `relayHostAttachment` 增加按目标分派到 `attachRemoteWorkspaceSessionHost`（发行版
    `attachWorkspaceHost` 的 local/remote 两条分支）、`collectRelayWorkspacesAndTasks` 的 task 列举
    要按远程 scope 取而不是用本地 `listTasks`。
- 渲染层入口无法把 `remoteSessionId` / `initialTaskId` 传给 main：`IPlatformService` 的四个远控方法
  都是零参（`packages/shared/src/platform.ts`），preload 与 `relayIpc.ts` 只信 `event.sender.id`；
  发行版是 `startWebRemoteControl({workspacePath, workspaceIdentity, remoteSessionId, initialTaskId})`。
  要补的是签名 + preload + main IPC 三层，不是 UI 组件。
- 分片确认层的 `pendingAckMessageSeq` 合并与 replay 水位未还原（本仓库每帧立即回 ack），
  因此发行版 `onSendReady` 里的 `replayUnacknowledged()` 在开源侧没有对应能力，传输层也未暴露该回调。
- 无法从产物确定的：中继服务端行为（sid 回收策略、`t` 的过期语义、旧 sid 是回 AUTH_FAILED
  还是直接断链）、非生产环境的 relay 兜底地址常量。

### 复验结果（回环中继、全新实例）

改完上述各项后重跑：注册→鉴权→配对→bootstrap（9 工作区 / 71 任务）→建桥→设备端 Initialize
（6B，crc32 OK）→`PromiseSuccess`→`listSSHConfigAliases` 与 `createTempTextAttachment` 均
`success:true`→`workspace-reconnect-response success:true`→`workspace-list-updated` 1 次、
内容无重复、视图回显正确，判定全绿。单槽互踢场景：踢线后回到 `waiting_terminal`、
`failure` 未被误置、`deviceInfo` 已清，新的 `terminalClose` 没有把正常重连一起抑制掉。

## 11.5 传输层时序与状态机对齐（2026-09-28 第五轮）

依据是发行版 main 进程解包产物里设备端传输层的原始实现（其中保留了函数名注解，可逐条按语义核对），
不是行为猜测。改动集中在 `relayProtocol.ts`（抖动公式）、`relayHeartbeat.ts`（新增，保活与看门狗）、
`relayInboundFrames.ts`（新增，入站帧解析与错误码决策表）、`relayDeviceTransport.ts`（状态机）。

| 项 | 修正前 | 发行版 | 落点 |
| --- | --- | --- | --- |
| 心跳抖动 | `[9s,11s]`（把 0.2 当全宽） | 幅度 `min(2s, 周期*0.2)`，按**半宽**展开 → `[8s,12s]`，且下界保底 1ms | `resolveRelayHeartbeatJitterMs` / `resolveRelayHeartbeatDelay` |
| 随机源 | 直接 `Math.random()` | 非有限值退化为 0，上界压到开区间，避免抖动溢出 | `safeUnitRandom` |
| 普通断线重连 | 每次 1s + 0–2s 抖动 | 固定 `reconnectDelayMs`，**不加抖动** | `scheduleReconnect(delayMs)` |
| 抖动用途 | 全部重连 | 只用于异常路径（ack 超时、stale waiting），且该路径的延时**就是抖动本身**（0–2s），不是 `1s+抖动` | `reconnectAfterStaleWaiting(delayMs)` |
| ack 看门狗 | 5s 轮询，触发点 30–35s | 一次性 30s 定时器，每收到一次 pair_status ack 重新武装，语义是「距最后一次 ack 30s」 | `relayHeartbeat.rearm()` |
| stale waiting | 先降 `waiting_terminal`，用时间戳比窗口 | 计数器 + 15s 一次性恢复定时器，**全程保持 `paired`**；第二次 waiting 立即重来 | `handleStaleWaiting` |
| 出站门禁 | 只看 `state==="paired"` | `paired` 且 `staleWaitingCount===0` 才发；待发队列的 flush 同口径 | `sendPayload` / `pendingOutbound.isPaired` |
| 重注册 | 丢掉 auth 让上层重新解析，延时 1s | 沿用同一份 `passHash` 切回 register 模式，延时 0 | `retryWithRegisterAuth` |
| 主动关链路重连 | 靠 `scheduleReconnect` 内部守卫 | 显式 `suppressNextCloseReconnect`，避免这次主动 close 再排一次重连 | close 回调 |
| 入站帧未知 `pair_status` | 无动作（已一致） | 只认 `waiting`/`matched` | `applyPairStatus` |
| `auth_challenge` 早于 `device_sid` | 只置 error 并关链路 | 终局（`terminalClose`），不再重连 | `enterTerminalError` |

一处**主动偏离**发行版，需在复核时注意：

- 发行版的 `onError` 只打日志，运行时的 `failure` 仅在两处被写入——被中继踢下线
  （`session-conflict`）与功能门禁关闭（`unsupported-action`）。本仓库把传输层终局错误也写进
  `failure` 并在弹窗展示，是为了让「中继拒机」这类用户可见的失败有一句解释。
  代价是本仓库的 `WebRemoteControlFailureReason` 枚举比发行版宽，多出的取值只在开源侧出现。
- INTERNAL 在会话未激活时走「可恢复错误」：置 `error` 状态、不上抛 `failure`，靠 close→重连自愈。
  这与发行版一致（那条路径同样只 `setState("error")` + 记日志）。

`mobileConnected` 3s 宽限仍未实现：发行版在传输态回到 connecting/waiting 时，若此前已有终端
连上，状态会先留在 `active`，3s 内没恢复才降为 `running`。本仓库的胶囊在离开 `paired` 时立即回落，
因此踢线→重连这 1–2s 窗口内会短暂显示「已就绪」，发行版不会。

## 12 风险

- 中继属厂商服务，协议可随时变更；无 SLA，且属于对官方构建之外客户端的非预期用法，需自行判断服务条款尺度。
- 分片/确认层（`seq`/`fragmentIndex`/crc32/8 MiB replayBuffer）尚未逐位还原，P3 阶段需以实测收敛，否则表现为「连上但偶发丢帧」。
- 本仓库与官方发行版同号不同代码树（发行 build `ab4d5e6b` 不在本历史中），行为对齐需实测确认。
