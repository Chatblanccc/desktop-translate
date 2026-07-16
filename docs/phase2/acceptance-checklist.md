# Phase 2 工程与实机验收清单

状态：`NOT RUN`

本清单是 Phase 2 的唯一签字入口。创建清单不表示任何条目已经通过；每个勾选项必须关联可重复命令、测试输出、CI run、截图或人工记录。阶段结论只能是 `PASS` 或记录完整风险后的 `PASS WITH ACCEPTED RISKS`。

## A. 范围与版本

- [ ] 根 workspace、Desktop 应用和可见版本统一为 `0.2.0-phase2`。
- [ ] 产品 UI 为简体中文、Windows 11 原生简约风格，未加入渐变、Mica 或远程资源。
- [ ] Phase 2 未实现翻译卡、Provider、历史/收藏、语言设置、OCR runtime/model、安装器、签名或自动更新。
- [ ] C++ 未被修改；若发生修改，已有单独范围评审和 ADR。
- [ ] 产品和测试报告将结果称为“内部开发预览”，未声称正式发布。

## B. 窗口、Tray 与交互

- [ ] 启动后恰好存在一个 `56 × 56 DIP` 悬浮球和一个 Tray。
- [ ] Ball 透明无框、不可缩放、跳过任务栏、启动不抢焦点，且不使用 click-through。
- [ ] 中央按钮可用左键、Enter 和 Space 打开/聚焦 Settings，右键显示原生菜单；外圈可拖动。
- [ ] Tray 菜单顺序、只读状态、显示开关、打开设置、重置位置和退出行为符合产品规格。
- [ ] Settings 是单例标准窗口，关闭只隐藏；Tray 和 Ball 均可恢复它。
- [ ] 隐藏 Ball 后 Tray 保留，且可恢复 Ball。
- [ ] 主题 `system/light/dark` 立即生效并在 Ball、Settings、Tray 间保持一致。
- [ ] Ball 和 Settings 具有可读无障碍名称、键盘焦点样式、高对比模式与 reduced-motion 行为。

## C. 位置、显示器与持久化

- [ ] 首次位置为主显示器右边缘、12 DIP 边距、工作区高度 60%。
- [ ] 开启吸附时拖动结束吸附最近左右边缘；关闭吸附时保留自由位置但仍不出工作区。
- [ ] `BallAnchor` 按 `displayId + edge + verticalRatio` 持久化，不保存 physical-px 坐标。
- [ ] 负坐标、多显示器、100%/150%/200% DPI、任务栏四边和分辨率变化的纯几何测试通过。
- [ ] 保存显示器移除或工作区变化后，Ball 回退到有效显示器并完整可见。
- [ ] 重置位置恢复默认锚点。
- [ ] `ui.ball.visible`、`ui.ball.edgeSnap`、`ui.ball.anchor`、`ui.theme` 通过 Main-only SQLite repository 持久化。
- [ ] 设置缺失、未知字段、非法枚举、越界比例和损坏 JSON 均安全回退，不阻止启动。

## D. 生命周期与 Native 降级

- [ ] Shell Controller 多次启动/停止和重复命令均幂等，不重复注册资源。
- [ ] 无 `SELECTION_HOST_PATH` 时 UI 正常运行并显示 `unavailable`。
- [ ] Host 启动期间显示 `starting`；正常 health 显示 `ready` 或明确的 `degraded`。
- [ ] 缺少 OCR runtime 映射为 `degraded` 且列出 `ocr`，不退出 UI。
- [ ] Host 缺失、握手失败、断线、重启耗尽和熔断均只更新状态，不退出 UI。
- [ ] Phase 2 Host 流量只有 hello/health/shutdown，未发送 `start`，health 始终证明 `listening=false`。
- [ ] 启动第二实例只恢复并聚焦既有 Settings，不增加 Tray、Ball、Host 或 listener。
- [ ] Settings 关闭不退出；Tray“退出”执行幂等清理并等待 Supervisor 停止。
- [ ] 完全退出后无 Electron、`selection-host.exe`、Tray、窗口或 IPC listener 残留。

## E. Electron 与 IPC 安全

- [ ] 每个 BrowserWindow 均为 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webviewTag:false`。
- [ ] 生产页面 CSP 包含 `connect-src 'none'`，且只加载本地构建资源。
- [ ] 权限请求/检查、下载、任意导航、`window.open` 和 `<webview>` 被拒绝。
- [ ] Renderer 无 `require`、Node `process`、SQLite、原始 Electron API 或网络能力。
- [ ] Ball 与 Settings 使用独立 Preload；未暴露通用 `send/on/invoke`、channel 字符串或 Electron event。
- [ ] 每个订阅返回精确 unsubscribe，窗口销毁后无 listener 泄漏。
- [ ] Main 对 IPC 同时验证 webContents、角色、main frame、来源 URL 和 payload。
- [ ] Ball 调用 Settings 写接口、错误窗口、子 frame、错误来源、非法 payload 和未知字段均被拒绝。
- [ ] 日志和 artifact 不含 Pipe 名、nonce、完整路径、设置原值或 Native stderr payload。

## F. 自动化门禁

- [ ] `pnpm lint` 通过。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过，且没有关键测试被 skip。
- [ ] `pnpm test:coverage` 通过门槛：Main/Preload lines/functions ≥90%、branches ≥85%；Renderer lines/functions ≥80%、branches ≥75%。
- [ ] IPC 授权、导航阻止、退出与单实例关键分支覆盖率为 100%。
- [ ] `pnpm build` 生成生产 Main、两个 Preload 和两个 Renderer 入口。
- [ ] `pnpm test:e2e` 使用生产 Renderer 构建通过无 Host、有效 Host、第二实例、隐藏/恢复、关闭到托盘和完全退出场景。
- [ ] `pnpm phase2:smoke` 通过最小真实启动/退出 smoke。
- [ ] `pnpm phase1:verify` 完整回归通过，包括 Contract、Desktop、Native CTest 和 Named Pipe smoke。
- [ ] `pnpm phase2:verify` 在干净 checkout 上完整通过并严格传播每个外部命令退出码。
- [ ] Windows CI 使用 frozen lockfile 执行同一门禁，完整 diff check 通过，并在失败或成功时保留 E2E artifacts。
- [ ] CI run URL、commit SHA、测试数量、覆盖率摘要和构建结果已记录在验收证据中。

## G. Windows 11 实机验收

- [ ] 在未配置 Host 的生产构建上启动，Ball、Tray、Settings 均可用，状态为 `unavailable`，应用不退出。
- [ ] 实际操作 Ball 左键、右键、Enter、Space 和拖动，验证不抢焦点、可吸附左右边缘且不越出当前工作区。
- [ ] 修改 Ball 可见性、边缘吸附和主题；完全退出并重启后设置与位置正确恢复。
- [ ] 从 Tray 隐藏/恢复 Ball；关闭 Settings 后应用仍常驻。
- [ ] 启动第二实例，确认只聚焦已有 Settings。
- [ ] 使用有效 `selection-host.exe` 启动，确认 health 正常、OCR 为 degraded、`listening=false`。
- [ ] 使用 Windows 桌面自动化实际点击并保存关键状态截图或录像。
- [ ] 从 Tray 完全退出，并用进程检查确认 Electron 与 `selection-host.exe` 无残留。
- [ ] 实机记录包含 Windows 版本、分辨率、工作区、DPI、应用 commit、命令和 artifact 路径。

## H. 延期矩阵与已知限制

- [ ] 已明确记录：多屏负坐标、显示器热插拔、任务栏换边和 100%/150%/200% DPI 的人工实机矩阵不阻塞本次单屏验收。
- [ ] 延期项目均有对应自动化 fixture，不存在以“延期”为由跳过的核心几何测试。
- [ ] 已知限制不包含 P0/P1 缺陷；所有剩余风险均有 owner、影响、状态和复审日期。

## 验收证据

- Commit SHA：`待填写`
- Windows CI run：`待填写`
- 自动化测试与覆盖率摘要：`待填写`
- 实机环境：`待填写`
- 实机截图/录像目录：`待填写`
- 已知限制与接受风险：`待填写`

## 审核签字

- [ ] 架构/安全负责人确认窗口、IPC 与 Native 边界；负责人：`待填写`；日期：`待填写`
- [ ] Windows 桌面负责人确认自动化与实机结果；负责人：`待填写`；日期：`待填写`
- [ ] 产品负责人确认 Phase 2 范围和内部预览口径；负责人：`待填写`；日期：`待填写`
- [ ] 结论：`NOT RUN`（完成验收后仅可改为 `PASS` 或 `PASS WITH ACCEPTED RISKS`）
