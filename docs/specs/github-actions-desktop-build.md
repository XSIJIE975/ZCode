# GitHub Actions 桌面构建

## 背景

本仓库此前没有任何 CI（`.github/` 不存在），桌面安装包完全依赖开发者本机打包。宿主平台限制：
Windows 本机只能直出 win 包（electron-builder 的 mac 工具链只能在 macOS 上运行，linux 的
fpm/AppImage 工具链需要 Linux 宿主或 Docker）。GitHub 托管 runner 原生覆盖三平台工具链，
用于补齐 mac/linux 构建能力，同时让 win 构建不再依赖某台开发机。

## 产品规则

- CI 产物身份与本地 Preview 包同一套语义：`ZCODE_ENV=production` +
  `ZCODE_PREVIEW_IDENTITY=1` → 「ZCode Preview」身份（appId `dev.zcode.app.preview`）+
  生产后端，可与已安装的正式版并排运行。身份机制唯一来源是
  `packages/desktop/scripts/desktop-product-identity.mjs`，workflow 只设环境变量，不另造身份。
- CI 产物不签名：mac 走 `electron-builder.config.js` 的 `identity: null` 未签名路径
  （`ZCODE_ENABLE_MAC_SIGN` 不设置即可），notarize 已显式关闭；win NSIS 与 linux 目标本身
  不需要证书。发布级签名/公证需要证书 secrets 与独立流程，不在本 workflow 范围。
- 未签名 mac 产物首次打开会被 Gatekeeper 拦截，需
  `sudo xattr -rd com.apple.quarantine /Applications/<App>.app`（README 打包章节同款说明）。
- 触发方式分两轨：手动 `workflow_dispatch` 只构建并上传 artifacts（测试用）；
  推送 `xcode-v*` tag 触发构建 + 自动创建 GitHub Release 并挂载全部产物（发布用）。
  workflow_dispatch 不发布，发布只能由 tag 触发。
- tag 命名空间固定为 `xcode-v<version>`（如 `xcode-v3.14.3`），且应指向 feature/xcode
  的提交：main 分支追踪上游仓库，`v*` 前缀留给上游 tag，避免同步上游时误触发发布。
- Release 由独立的 `release` job 创建（`needs: bundle`，三平台全部成功才发布；
  job 级 `permissions: contents: write`）。`gh release view` 判重：已存在则
  `--clobber` 覆盖同名产物，保证 workflow 重跑幂等；不存在则创建并附静态说明
  （未签名产物、macOS xattr 解锁、Preview 身份与官方版并排的说明）。
- 分支模型：main 仅作上游镜像（不改），日常开发与构建都在 feature/xcode，
  workflow_dispatch 在 Actions 页切换分支或 `gh workflow run --ref` 触发。

## 接口与所有者

- workflow：`.github/workflows/desktop-build.yml`，矩阵 `win-x64` / `mac-arm64` / `linux-x64`。
- 打包流程唯一所有者是 `packages/desktop/scripts/bundle.mjs`
  （runtime 资产准备 → 生产构建 → electron-builder → 产物校验）。workflow 只负责
  装工具链、设环境变量、调用 `pnpm bundle:desktop`、上传产物，不复制任何打包逻辑。
- 工具链锚点：Node `24.14.0`（`mise.toml`）、pnpm `10.33.2`
  （根 `package.json` 的 `packageManager`，`pnpm/action-setup@v4` 自动读取）。
- 下载源：GitHub runner 直连官方源最快，通过 bundle.mjs 暴露的 mirror 环境变量覆盖
  （`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 指向官方 URL；
  bundle.mjs 默认的 npmmirror 镜像保留给国内本地环境，不在 CI 覆盖）。
- `ZCODE_SKIP_REMOTE_ASSETS=1` 仅设在 win job：CI 先例表明 Windows 桌面安装包不依赖
  mock-cdn remote 资产，跳过可省去跨平台资源下载；mac/linux 保持默认全量准备。

## 验收场景

1. `workflow_dispatch` 触发后三个矩阵 job 全绿，artifacts 分别包含对应安装包：
   `ZCode Preview-<version>-win-x64.exe`、`...-mac-arm64.dmg/.zip`、
   `...-linux-x64.AppImage/.deb/.rpm/...`，且不产生 GitHub Release。
2. 推送 `xcode-v*` tag 后：三个 bundle job 全绿 → `release` job 在 Releases 页创建
   该 tag 的 Release，包含三平台全部安装包与静态说明。
3. 本地链路校验：`pnpm bundle:desktop -- --os win --arch x64 --dry-run` 能正确解析
   target 并打印最终 electron-builder 命令（已执行通过，2026-10-08）。
4. workflow YAML 可被标准解析器加载（写完后本地用 `yaml` 库校验）。
5. 已知首次实跑风险：linux 目标的 AppImage/deb 工具链由 electron-builder 自动下载，
   若 runner 网络受限会在此失败；mac 未签名产物属预期，不视为构建失败。
