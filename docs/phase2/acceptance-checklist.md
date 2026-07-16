# Phase 2 工程与实机验收清单

状态：`PASS WITH ACCEPTED RISKS`

验收日期：2026-07-16。唯一接受风险为 [P2-R-017](risk-register.md)：当前同屏桌面自动化驱动不能生成 Windows 原生窗口拖动，即使对标准 Settings 标题栏也不能移动窗口，因此缺少独立物理拖动录像。该限制不代表已观察到 Ball 拖动缺陷；拖动区域、移动回调、左右吸附和显示器几何均由自动化覆盖。

## A. 范围与版本

- [x] 根 workspace、Desktop 应用和可见版本统一为 `0.2.0-phase2`。
- [x] 简体中文 Windows 11 原生简约 UI，无渐变、Mica 或远程资源。
- [x] 未实现翻译卡、Provider、历史/收藏、OCR runtime/model、安装器、签名或自动更新。
- [x] C++ 未修改；结果口径固定为“内部开发预览”。

## B. 窗口、Tray 与交互

- [x] 启动后恰好一个 `56 × 56 DIP` Ball 和一个 Tray；Ball 透明无框、不可缩放、跳过任务栏并以 `showInactive()` 启动。
- [x] 中央 `44 × 44 DIP` 为 `no-drag` 按钮，左键、Enter、Space 打开 Settings，右键打开原生菜单；外圈声明为 `app-region: drag`。
- [x] Tray 顺序精确为状态、显示悬浮球、打开设置、重置位置、分隔线、退出。
- [x] Settings 单例且关闭只隐藏；Tray 与 Ball 均可恢复，隐藏 Ball 不影响 Tray。
- [x] `system/light/dark` 即时同步；无障碍名称、focus-visible、高对比和 reduced-motion 测试通过。

## C. 位置、显示器与持久化

- [x] 默认位置为主屏右边缘 12 DIP、工作区高度 60%，所有坐标均 clamp 到工作区。
- [x] 左右吸附、关闭吸附后的会话内自由位置、重置位置和逻辑锚点计算通过。
- [x] `BallAnchor` 仅持久化 `displayId + edge + verticalRatio`；不保存 physical-px。
- [x] 负坐标、多屏、显示器移除、100%/150%/200% DPI、任务栏四边和工作区变化 fixture 通过。
- [x] `ui.ball.visible`、`ui.ball.edgeSnap`、`ui.ball.anchor`、`ui.theme` 由 Main-only SQLite repository 持久化。
- [x] 缺失、未知、非法枚举、越界比例与损坏 JSON 均安全回退。

说明：`edgeSnap=false` 时精确自由 x 只在当前会话保留；跨重启按冻结契约恢复最近逻辑边缘。这是已记录的 Phase 2 契约边界，不是数据丢失缺陷。

## D. 生命周期与 Native 降级

- [x] ShellController、重复命令、启动中退出和重复 dispose 均幂等，不重复注册资源。
- [x] 无 Host 时 UI 为 `unavailable` 且不退出；真实 Host 正常进入 `degraded` 并列出 `ocr`。
- [x] Host 缺失、握手失败、断线、重启耗尽和熔断只更新 UI 状态。
- [x] Host 流量仅为 hello/health/shutdown；未发送 `start`，health 为 `listening=false`。
- [x] 第二实例只恢复既有 Settings；关闭 Settings 不退出，Tray“退出”等待 Supervisor 清理。
- [x] 完全退出后无 Electron、`selection-host.exe`、窗口、Tray 或 IPC listener 残留。

## E. Electron 与 IPC 安全

- [x] 所有 BrowserWindow 使用 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webviewTag:false`。
- [x] 生产 CSP 含 `connect-src 'none'`，仅加载本地构建资源。
- [x] 权限、下载、导航、redirect、`window.open` 与 `<webview>` 均被拒绝。
- [x] Renderer 无 `require`、Node `process`、SQLite、原始 Electron API 或网络能力。
- [x] Ball/Settings 使用独立最小 Preload；订阅返回 unsubscribe，不暴露通用 send/on/invoke。
- [x] Main 同时验证 webContents、角色、main frame、来源 URL 和精确 payload；越权与非法调用均被拒绝。
- [x] 提交内容与验收 artifact 未包含用户绝对路径、Pipe 名、nonce、设置原值或 Native stderr payload。

## F. 自动化门禁

- [x] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:coverage` 全部通过，无关键 skip。
- [x] 覆盖率：statements 94.98%、branches 88.45%、functions 95.10%、lines 96.91%，满足各层门槛。
- [x] `pnpm build` 生成 Main、两个 Preload 与两个 Renderer。
- [x] `pnpm test:e2e` 与 `pnpm phase2:smoke` 均为 2/2 通过。
- [x] `pnpm phase1:verify` 完成 Contracts、Desktop、Native CTest 和真实 Named Pipe 回归。
- [x] `pnpm phase2:verify` 本地退出码 0，用时 71.9 秒；142 个 JS/TS 测试、2 个 E2E、1 个 Native CTest。
- [x] Windows CI 使用 Node 22.23.1、pnpm 10.32.1 与 frozen lockfile，完整 diff/门禁/tracked mutation 检查通过。
- [x] E2E artifact `phase2-e2e-29493975306-1` 已上传，保留 14 天。

## G. Windows 11 实机验收

- [x] 无 Host 的生产构建中 Ball、Tray、Settings 可用，状态为“未连接”，应用保持常驻。
- [ ] 独立物理鼠标拖动录像：接受风险 P2-R-017；系统鼠标自动化同样无法移动标准 Settings 标题栏，故未把工具失败误记为产品通过或缺陷。
- [x] 左键、右键、Enter、Space、显示/隐藏、主题、边缘吸附设置和重启持久化均实际操作通过。
- [x] Tray 隐藏/恢复、Settings 关闭到 Tray、第二实例聚焦既有窗口均通过。
- [x] 真实 `selection-host.exe` 显示 OCR degraded；Named Pipe health 为 `listening=false`。
- [x] Windows 桌面自动化保存关键截图；Tray 退出后进程扫描无残留。
- [x] 实机环境为 Windows 11 Pro 10.0.26200、1920×1080、workArea 1920×1032、96 DPI/100%。

## H. 延期矩阵与已知限制

- [x] 多屏负坐标、热插拔、任务栏换边和 150%/200% DPI 人工矩阵不阻塞本次单屏验收，均有自动化 fixture。
- [x] 无 P0/P1 缺陷；所有关闭项和唯一接受风险均有 owner、证据、影响与复审日期。
- [x] 交付仍为内部开发预览，不包含安装、签名、自动更新或正式发布。

## 验收证据

- 代码基线：[`0372b54a7a11df5339568ef588f07018fd6ef89e`](https://github.com/Chatblanccc/desktop-translate/commit/0372b54a7a11df5339568ef588f07018fd6ef89e)
- Phase 2 Windows CI：[run 29493975306](https://github.com/Chatblanccc/desktop-translate/actions/runs/29493975306)（PASS）
- Phase 1 Windows 回归：[run 29493975265](https://github.com/Chatblanccc/desktop-translate/actions/runs/29493975265)（PASS）
- 详细命令、覆盖率与实机记录：[validation-report.md](validation-report.md)
- 本地截图目录：`artifacts/phase2/manual/`

## 审核签字

- [x] 架构/安全：Codex 代码与测试审计；2026-07-16。
- [x] Windows 桌面：Codex 自动化与实机验收；2026-07-16。
- [x] 产品范围：Chatblanccc（本任务明确 Phase 2 范围并授权自主验收）；2026-07-16。
- [x] 结论：`PASS WITH ACCEPTED RISKS`。
