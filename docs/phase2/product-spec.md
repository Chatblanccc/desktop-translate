# Phase 2 产品规格：桌面壳层

- 状态：已冻结，待实现与验收
- 版本：`0.2.0-phase2`
- 目标平台：Windows 11 x64；Windows 10 22H2 x64 仅保留兼容目标
- 发布口径：内部开发预览，不是安装包或正式发布版本

## 1. 阶段目标

Phase 2 交付一个在没有 Native Host 时仍能正常启动和操作的 Electron 桌面壳层。它由一个常驻悬浮球、一个系统托盘入口和一个最小设置窗口组成，并提供安全的窗口/IPC 边界、设置持久化、单实例生命周期和 Native 能力状态展示。

本阶段只证明桌面产品壳层可用。它不得发送 Native `start`、安装全局取词 Hook、消费 `selection/result`、截图、调用 OCR 或发起翻译请求。

## 2. 用户入口与交互

### 2.1 悬浮球

- 固定为 `56 × 56 DIP`，透明、无边框、不可缩放，跳过任务栏。
- 使用 Windows 11 中性色、系统强调色、Segoe UI 和本地单色“文/A”图标；禁止渐变、Mica 和远程资源。
- 窗口保持在普通应用之上、Windows 任务栏之下；创建后以 `showInactive()` 显示，不抢走当前应用焦点。
- 中央至少 `44 × 44 DIP` 是 `no-drag` 按钮区：左键、Enter 或 Space 打开/聚焦设置；右键打开原生上下文菜单。
- 外圈是拖动区。拖动结束后，如果边缘吸附开启，吸附到最近显示器工作区的左边或右边。
- 首次启动位于主显示器右边缘，距边缘 `12 DIP`，垂直位置为可用工作区高度的 `60%`。
- 悬浮球必须拥有可读的无障碍名称、明显的键盘焦点样式，并尊重高对比模式和 `prefers-reduced-motion`。

### 2.2 系统托盘

应用运行期间必须恰好存在一个 Tray。菜单顺序固定为：

1. 当前 Native 状态（只读、不可点击）。
2. 显示悬浮球（勾选项）。
3. 打开设置。
4. 重置悬浮球位置。
5. 分隔线。
6. 退出 Desktop Translate。

Tray 左键打开/聚焦设置，右键显示菜单。隐藏悬浮球后 Tray 仍必须保留，确保用户始终有恢复和退出入口。

### 2.3 设置窗口

- 标准、可聚焦、非透明、非置顶窗口；只允许一个实例。
- 关闭按钮只隐藏窗口，不退出应用；再次打开时恢复并聚焦已有窗口。
- “常规”区域提供：显示悬浮球、边缘吸附、主题 `跟随系统/浅色/深色`、重置悬浮球位置。
- “关于与状态”区域显示应用版本、Native 状态和降级能力。Phase 2 缺少 OCR runtime 时明确显示 OCR 降级，不把它描述为故障恢复完成。
- 简体中文是 Phase 2 唯一产品语言。设置变更立即生效并同步到 Ball、Settings 和 Tray，不提供“保存”按钮。

## 3. 生命周期与失效行为

- Main 是窗口、Tray、设置、位置和 Native UI 状态的唯一权威源。
- 启动顺序固定为：安全策略 → 设置存储 → Tray/悬浮球 → Native Host 探测。
- 未配置 `SELECTION_HOST_PATH` 时状态为 `unavailable`，UI 继续运行。
- Host 启动/握手期间为 `starting`；握手和 health 正常且无能力降级时为 `ready`；报告缺少 OCR 等能力时为 `degraded`；启动、握手、断线、重启耗尽或熔断后为 `faulted`。
- Phase 2 只允许 `hello → ready → health → shutdown` 生命周期；禁止 `start`，并要求 health 中 `listening=false`。
- 第二个应用实例不得创建额外窗口、Tray、Host 或 listener，只恢复并聚焦既有设置窗口。
- 只有 Tray“退出”触发完全退出。退出必须幂等，停止 Native Supervisor、移除 IPC listener、销毁窗口和 Tray，且不得留下 `selection-host.exe`。
- 损坏或未知设置值必须回退到默认值并记录不含值内容、完整路径、Pipe 名或 nonce 的诊断；不得阻止 UI 启动。

## 4. 位置与显示器规则

悬浮球位置持久化为逻辑锚点，而不是 physical-px 坐标：

```ts
interface BallAnchor {
  displayId: string;
  edge: "left" | "right";
  verticalRatio: number; // 0..1
}
```

- `verticalRatio` 相对于显示器当前 `workArea` 计算，并在读取时限制到 `0..1`。
- 若保存的 `displayId` 不存在，回退到主显示器；若窗口与多个屏幕相交，选择相交面积最大的显示器。
- 所有最终坐标按当前 `workArea` clamp，确保完整的 56 DIP 球体可见，并保留 12 DIP 边距。
- 显示器增加、移除、分辨率、缩放或任务栏工作区变化时重新计算位置。
- 关闭边缘吸附后允许自由拖动，但仍必须 clamp 在工作区内；重置操作恢复默认右边缘/60% 锚点。

## 5. 状态与持久化契约

跨进程只发布不可变快照：

```ts
type ThemeMode = "system" | "light" | "dark";
type NativeUiStatus =
  | "unavailable"
  | "starting"
  | "ready"
  | "degraded"
  | "faulted";

interface UiShellSnapshot {
  version: 1;
  ball: {
    visible: boolean;
    edgeSnap: boolean;
    anchor?: BallAnchor;
  };
  theme: ThemeMode;
  native: {
    status: NativeUiStatus;
    degradedCapabilities: readonly string[];
  };
}
```

Main-only SQLite repository 复用现有 `settings` 表，键名固定为：

- `ui.ball.visible`
- `ui.ball.edgeSnap`
- `ui.ball.anchor`
- `ui.theme`

默认值为悬浮球可见、边缘吸附开启、主题跟随系统、默认位置锚点。Renderer 和 Native Host 不得直接访问数据库。

## 6. 阶段外内容

- 真实划词、全局 Hook、`selection/result`、翻译卡片和卡片定位。
- 百度或其他翻译 Provider、网络策略、语言设置、历史、收藏和密钥管理。
- OCR runtime/model 捆绑、真实应用兼容矩阵和多屏人工验收。
- 安装器、免安装包、代码签名、自动更新、SBOM 和正式发布。
- 默认不修改 C++；若 Electron 壳层无法在现有 health 契约下完成，必须先新增范围评审和 ADR。

## 7. 完成定义

只有 [Phase 2 验收清单](acceptance-checklist.md) 的自动门禁、Windows 11 实机步骤和签字均完成，且无未处置的 P0/P1 缺陷，才能把本阶段标为 `PASS` 或 `PASS WITH ACCEPTED RISKS`。代码存在、窗口可截图或单次本地启动均不等于阶段通过。
