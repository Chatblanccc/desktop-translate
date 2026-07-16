# Phase 2 验证报告

- 验证日期：2026-07-16
- 版本：`0.2.0-phase2`
- 发布口径：内部开发预览
- 当前结论：`PASS WITH ACCEPTED RISKS`
- 代码基线：`0372b54a7a11df5339568ef588f07018fd6ef89e`
- Windows CI：[Phase 2 run 29493975306](https://github.com/Chatblanccc/desktop-translate/actions/runs/29493975306)

> 本阶段代码、自动门禁、真实 Windows CI 和核心实机流程均通过。唯一接受风险是当前桌面自动化驱动无法生成 Windows 原生窗口拖动，缺少独立物理拖动录像；详见 P2-R-017。

## 1. 验证环境

| 项目 | 实际值 |
|---|---|
| 操作系统 | Windows 11 Pro x64（10.0.26200） |
| 显示器 | 单屏，`1920 × 1080` |
| 工作区 | `1920 × 1032` |
| DPI / 缩放 | `96 DPI` / `100%` |
| 包管理器 | pnpm `10.32.1`（仓库锁定版本） |
| Native Host | 无 Host 和真实 `selection-host.exe` 两种配置 |

本轮人工实机只覆盖当前单屏。多屏、负坐标、显示器移除、任务栏换边以及 100%/150%/200% DPI 由自动化 Display fixture 覆盖，未作为本轮单屏人工验收的阻塞项。

## 2. 实际命令与结果

本地依赖和完整门禁：

```powershell
pnpm install --frozen-lockfile
pnpm phase2:verify
pnpm phase2:smoke
```

结果：三条命令均以退出码 `0` 完成；最新完整 `phase2:verify` 用时约 `71.9s`，独立 `phase2:smoke` 为 `2 passed`。该门禁按顺序执行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm test:e2e
pnpm phase1:verify
```

生产构建实机启动入口：

```powershell
# 无 Native Host
Remove-Item Env:SELECTION_HOST_PATH -ErrorAction SilentlyContinue
pnpm start:phase2

# 真实 Native Host
$env:SELECTION_HOST_PATH = '<repo>\native\out\build\windows-x64-llvm-mingw\selection-host\selection-host.exe'
pnpm start:phase2
```

其中 `<repo>` 代表本地仓库根目录；报告不记录用户目录绝对路径。两种启动方式均运行已构建的 Electron 应用，不生成安装器或免安装包。

## 3. 自动化结果

### 3.1 测试数量

| 测试组 | 结果 |
|---|---:|
| Contracts | `19 passed` |
| Storage | `7 passed` |
| Desktop 单元、组件与 Main/Preload 集成 | `116 passed` |
| JS/TS 小计 | `142 passed` |
| Electron E2E | `2 passed` |
| Native CTest | `1 passed` |

没有关键测试被跳过。`phase1:verify` 同轮完成 Contract、Desktop、Native CTest 和真实 Named Pipe smoke 回归；smoke 返回 `degraded`、`listening=false`、`degradedCapabilities=["ocr"]`。

### 3.2 覆盖率

| 指标 | 覆盖率 | 命中 / 总数 |
|---|---:|---:|
| Statements | `94.98%` | `928 / 977` |
| Branches | `88.45%` | `406 / 459` |
| Functions | `95.10%` | `233 / 245` |
| Lines | `96.91%` | `849 / 876` |

覆盖率门槛通过。IPC 授权、导航阻止、单实例和退出等关键生命周期分支包含专门的 Main/Preload 集成及回归测试。

### 3.3 构建与安全断言

生产构建成功生成并真实加载：

- Electron Main；
- Ball 与 Settings 两个隔离 Preload；
- Ball 与 Settings 两个 React Renderer。

E2E 对生产 Renderer 执行了无 Host、Native 降级、第二实例、设置持久化、隐藏/恢复、关闭到 Tray 和完全退出场景。Renderer 中 `require`、Node `process`、原始 Electron API 与外部网络访问均不可用；导航、下载、权限请求和 `window.open` 被拒绝。Native fixture 记录的方法仅包含 `hello`、`health`、`shutdown`，未出现 `start`。

## 4. Windows 11 实机结果

### 4.1 无 Native Host

- 生产构建启动后出现一个 `56 × 56 DIP` 悬浮球和一个 Tray，应用未退出。
- 首次 Ball 边界为 `x=1852, y=583, width=56, height=56`，符合右侧 `12 DIP` 边距和工作区高度 60% 的默认位置，且完整位于 `1920 × 1032` 工作区内。
- 左键、Enter 和 Space 均可打开 Settings；Settings 显示“原生服务：未连接”。
- Ball 可见性、边缘吸附和深色主题可切换；完全退出并重启后主题、可见性和位置恢复。
- Ball 右键原生菜单顺序为：状态、显示悬浮球、打开设置、重置位置、退出。
- 关闭 Settings 后应用继续驻留 Tray；Ball 使用 Alt+F4 时只隐藏，不终止应用。
- 启动第二实例只恢复并聚焦已有 Settings，主进程数量保持为一个。

### 4.2 真实 Native Host

- 使用仓库构建产物 `native/out/build/windows-x64-llvm-mingw/selection-host/selection-host.exe` 启动。
- Settings 显示“原生服务：部分可用”和“OCR 未配置”。
- 运行期只存在一个 `selection-host.exe` 子进程。
- 同轮真实 Named Pipe health smoke 确认 `listening=false`；Phase 2 未安装全局 Hook、未处理选区，也未发送 Native `start`。
- 从 Tray 执行“退出”后，进程扫描未发现 Desktop Translate Electron 或 `selection-host.exe` 残留。

### 4.3 截图证据

以下均为仓库根目录相对路径：

- `artifacts/phase2/manual/01-ball-default.png`：默认悬浮球；
- `artifacts/phase2/manual/02-settings-unavailable.png`：无 Host 的 Settings；
- `artifacts/phase2/manual/03-settings-dark.png`：深色主题；
- `artifacts/phase2/manual/05-real-host-degraded.png`：真实 Host 的 OCR 降级状态。

## 5. 真实鼠标拖动证据说明

Windows 桌面自动化多次向 Ball 外圈发送系统鼠标拖动。为排除 Codex 同屏遮挡，验收期间还临时把未提交的测试实例提升到更高窗口层级；点击可正常命中 Ball，但 drag 仍不能移动窗口。对同层级的标准 Settings 标题栏执行相同拖动也不能移动窗口，证明该结果是当前自动化驱动无法生成 Windows 原生窗口拖动，而不是 Ball 特有失败。临时测试覆盖未进入提交，最终生产构建已从干净代码基线重建。

这是验收工具限制，依据如下：

- Ball 的点击、右键、Enter、Space、显示/隐藏和菜单交互在实机上均可操作；
- 外圈 drag / 中央 no-drag 的结构和 Main 输入路径有自动化覆盖；
- 左右边缘吸附、工作区 clamp、位置持久化、负坐标、显示器增删、DPI 与任务栏四边场景均有自动化几何覆盖；
- 未观察到应用崩溃、窗口穿屏或状态损坏等产品故障信号。

该证据缺口作为低风险 P2-R-017 接受，复审日期为 2026-08-15。它不得被描述为已经完成的物理拖动验收；后续应在独立桌面会话补录左右拖动。

## 6. 远端 CI 与签字

- [Phase 2 Windows run 29493975306](https://github.com/Chatblanccc/desktop-translate/actions/runs/29493975306)：frozen install、完整 diff、`phase2:verify`、tracked mutation 检查和 artifact 上传全部成功。
- [Phase 1 Windows run 29493975265](https://github.com/Chatblanccc/desktop-translate/actions/runs/29493975265)：完整回归成功。
- E2E artifact：`phase2-e2e-29493975306-1`，大小 227,116 bytes，保留至 2026-07-30。
- 最终审计：无 P0/P1/P2 代码缺陷；唯一剩余项为 P2-R-017 低风险验收工具限制。
- 验收清单与风险登记已于 2026-07-16 签字。

## 7. 范围外与已知限制

- 本交付是内部开发预览，不包含安装器、免安装包、代码签名、自动更新或正式发布流程。
- 不包含翻译卡、Provider、历史、收藏、OCR runtime/model、截图或真实选区消费。
- 不安装全局 Hook，不发起翻译网络请求。
- 本轮物理实机为单屏 100% DPI；多屏、负坐标、150%/200% DPI、任务栏换边和热插拔只完成自动化 fixture 覆盖。
- P2-R-017 仅为物理拖动录像证据缺口，不扩大产品权限或运行能力；正式结论为 `PASS WITH ACCEPTED RISKS`。
- 关闭边缘吸附后的自由横向位置只在当前会话保留；跨重启按锁定的 `displayId + edge + verticalRatio` 逻辑锚点恢复到最近边缘。精确自由 x 持久化不在已冻结的 Phase 2 契约和四个设置键之内。
