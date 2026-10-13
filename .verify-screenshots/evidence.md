# Step 7 可视化验证证据说明

采集环境：打包产物 `packages/desktop/dist/win-unpacked/ZCode Preview.exe`
（`ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1` 构建），以
`--remote-debugging-port=9223` 启动，通过 agent-browser CDP 驱动；应用使用真实
`~/.zcode`（已登录）以观察签名/配额链路。

## 验证点与证据

### ① 新会话首条消息前：无空壳统计条
- 证据：`01-new-session-before-first-message.png`（08:29 本地）
- 佐证命令与结果（实时采集，agent-browser CDP）：
  `snapshot -s "main" | grep -icE "轮|步|tps|token|统计|signed|签名"` → `0`

### ② 首轮数据到达：统计条出现 + 签名徽标「已签名发送」
- 证据：`03-first-turn-signed-stats-after-fix.png`（09:23 本地）、
  `05-stats-strip-annotated.png`（09:29 本地，带元素标注）
- 实时采集的 a11y 快照片段（agent-browser `snapshot -s "main"`，09:2x）：
  ```
  - StaticText "1 轮"
  - image "已签名发送"
  - button "统计条显示" [expanded=false, ref=e236]
  - textbox "提出后续修改要求" [ref=e195]:
  ```
- 实时采集的 DOM 片段（agent-browser `eval`，09:2x）：
  ```html
  <div class="... border-b border-input-border px-3 py-1.5 text-ui-xs text-foreground-subtle"
       data-testid="session-stats-bar">
    <span class="whitespace-nowrap font-mono" title="1 轮">1 轮</span>
    <span class="inline-flex shrink-0 items-center rounded-full p-0.5 leading-none
                 text-green-600 dark:text-green-400" title="...">
  ```
  （绿色 class 对应已签名态；修复前 02 截图中同一位置为黄色警示徽标）

#### 该验证点暴露并修复了一处合并回归
- 合并初版实测：徽标「未签名发送」，CLI 日志
  `model.client_signing.unsigned_sent reason=invalid_credential`
  （`providerId=account:bigmodel-individual-coding-plan`，`00:29:28Z`/`00:29:34Z`）。
- 根因：上游 3.15.1 将账号型 Coding Plan 的传输凭据换成 Project Token
  （`accountProviderRequestAuthService` 走 `loadIndividualPlanMaterial`），
  签名器要求的 id.secret 形态凭据不再进入 `requestAuth.apiKey`。
- 对照证据（合并前同 provider 可签名）：`~/.zcode/cli/log/zcode-2026-10-12.jsonl`
  中 `sess_c3827697`（provider `account:bigmodel-individual-coding-plan`）有
  `feature_gate enabled` 且无 `invalid_credential`。
- 修复：commit `879930aa`（signingApiKey 独立下传，传输 apiKey 保持 Project Token）。
- 修复后日志（`~/.zcode/cli/log/zcode-2026-10-13.jsonl`）：
  ```
  $ grep -c invalid_credential  (时间 >= 2026-10-13T01:15Z)  → 0
  $ grep -c feature_gate        (时间 >= 2026-10-13T01:15Z)  → 1
  $ 01:21:37.807Z model.client_signing.feature_gate enabled（traceId 00747ee7…，
    无伴随 unsigned_sent）
  ```

### ③ Web 远控入口可打开（上游官方实现）
- 证据：`07-web-remote-dialog.png`（09:39 本地）
- 弹窗内容（读图 + a11y）：标题「移动端远程控制」；左栏「手机扫码连接」含
  状态「启动中·无线连接」、二维码、「停止/刷新二维码/复制链接」；右栏
  「使用 Bot Channel」含 微信 / 飞书 / Lark / Telegram 四项入口
  （Bot Channel 为上游 3.15.1 官方能力，佐证 2B 取舍生效）。

### ④ 主进程日志无未捕获异常、无签名/captcha 报错
- 证据：应用主进程输出 `/tmp/app-run2.log`（651,119 字节 / 4,486 行）
  ```
  grep -icE "uncaught|unhandled|TypeError"  → 0
  grep -icE "signing.*(fail|error)|captcha.*(fail|error)|verify_rejected" → 0
  ```

## e2e 子集（改动面）
命令：`ZCODE_E2E_SPEC="container-boot,chat-input-mention-navigation,help-client-config,coding-plan-team-usage"`
（`NODE_TLS_REJECT_UNAUTHORIZED=0` 仅用于本机代理 MITM 下 chromedriver 下载）
结果（日志 `/tmp/e2e-subset3.log`）：
- `container-boot.test.ts`：**PASSED**（1 passing）——应用可启动
- `chat-input-mention-navigation.test.ts`：**PASSED**（2 passing）——输入/提及面可用
- `help-client-config.test.ts`：6 passing / 2 failing —— 失败为语言环境：
  用例期望英文 `Submit feedback` 与 `aria-label="Help"`，应用按系统语言渲染中文
  （实际收到「提交反馈…」）
- `coding-plan-team-usage.test.ts`：3 passing / 24 failing —— 隔离 e2e home
  无账号夹具 + 本机网络受限；失败信息均为「设置页没有出现或无法激活 Coding Plan tab」
  等账号态依赖断言

## 修复后门禁复验（日志：evidence-logs/gates-after-signing-fix.log）
- `pnpm lint`：62 warnings / 0 errors（= origin/main 基线）
- `pnpm architecture:check -- --changed`：violations 0 / new 0
- adapters 签名与 captcha 测试：16/16
- 受影响 services/shared 测试：35/35

## 已知边界
- 全新安装（无 ≤3.14.x 写入的凭据缓存）时，账号型 Coding Plan 的签名降级为未签名
  （不阻断请求）；上游 3.15.1 已退役远端签发长期 Key 的通路，需旧版本运行一次或
  使用 Coding Plan API Key 型 provider 才能获得 id.secret。
